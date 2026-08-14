// serve.js
import os, { platform } from 'os';
import bodyParser from 'koa-bodyparser';
import fsp from 'fs/promises';
import fs from 'fs';
import Koa, { Context } from 'koa';
import Router from '@koa/router';
import multer from '@koa/multer';
import path from 'path';
import { mkdirp } from 'mkdirp';
import config from './config';
import { BuildC } from './src';
import { uuidv4 } from '@ka-libs/crypto';
import { PassThrough } from 'stream';

const app = new Koa();
const router = new Router();

export const ip = (() => {
	const interfaces = os.networkInterfaces();

	for (const name of Object.keys(interfaces)) {
		const infos = interfaces[name];

		if (!infos) continue;

		for (const info of infos) {
			if (info.family === 'IPv4' && !info.internal) {
				return info.address;
			}
		}
	}

	return '127.0.0.1';
})();

function getBaseUrl(ctx: Context): string {
	// 优先级：环境变量 > X-Forwarded-Host > ctx.host
	const host = process.env.PUBLIC_URL || ctx.get('X-Forwarded-Host') || ctx.host;
	const protocol = ctx.get('X-Forwarded-Proto') || 'http';
	return `${protocol}://${host}`;
}

// 配置文件存储
const storage = multer.diskStorage({
	destination: (_req, _file, cb) => {
		const dir = config.pathes.uploads;
		mkdirp.sync(dir);
		cb(null, dir);
	},
	filename: (_req, file, cb) => {
		// 保留原始文件名，加时间戳防重名
		const ext = path.extname(file.originalname);
		cb(null, `${Date.now()}${ext}`);
	},
});

const upload = multer({
	storage,
	limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

app.use(bodyParser());

// ✅ 1. 任务状态管理器（生产环境建议替换为 Redis）
interface BuildTask {
	id: string;
	status: 'building' | 'completed' | 'failed';
	outputPath?: string;
	error?: string;
	clients: Set<PassThrough>;
}
const tasks = new Map<string, BuildTask>();

const tempDir = path.join(os.tmpdir(), 'ka-buildc');

// ✅ 2. 触发构建（立即返回，不阻塞）
router.post('/build', upload.single('file'), async (ctx) => {
	try {
		await fsp.rm(tempDir, { recursive: true });
	} catch (error) {}

	const file = ctx.file; // upload.single → ctx.file
	// const files = ctx.files;  // upload.array  → ctx.files[]
	const name = (ctx.request as any).body?.name;

	if (!name || typeof name !== 'string') {
		ctx.status = 400;
		ctx.body = { error: 'Missing or invalid "name" field' };
		return;
	}
	if (!file) {
		ctx.status = 400;
		ctx.body = { error: 'No file uploaded' };
		return;
	}

	const taskId = uuidv4();
	const task: BuildTask = { id: taskId, status: 'building', clients: new Set() };
	tasks.set(taskId, task);

	// 🔥 后台执行构建，不 await
	(async () => {
		try {
			// 向所有 SSE 客户端推送进度
			const notify = (base64: string) => {
				const data = JSON.stringify({ base64, timestamp: Date.now() });
				for (const client of task.clients) {
					// ✅ 统一使用标准 SSE message 格式（无 event 字段 = 默认 message）
					client.write(`data: ${data}\n\n`);
				}
			};

			// ⚠️ 替换为你的真实构建逻辑
			const buffer = await BuildC.build(name, {
				platform: os.platform(),
				cFile: file.path,
				notify,
			});

			const outputPath = path.join(tempDir, `${taskId}.7z`);
			await fsp.mkdir(path.dirname(outputPath), { recursive: true });
			await fsp.writeFile(outputPath, buffer);

			task.status = 'completed';
			task.outputPath = outputPath;

			// ✅ 构建成功后，向所有客户端发送 done 事件
			const doneData = JSON.stringify({ taskId });
			for (const client of task.clients) {
				client.write(`event: done\ndata: ${doneData}\n\n`);
			}
		} catch (err) {
			task.status = 'failed';
			task.error = (err as Error).message;
			const errData = JSON.stringify({ error: task.error });
			for (const client of task.clients) {
				client.write(`event: error\ndata: ${errData}\n\n`);
			}
		} finally {
			await fsp.unlink(file.path).catch(() => {});
			// ✅ 通知所有 SSE 客户端关闭连接
			for (const client of task.clients) {
				client.end();
			}
		}
	})();

	// const base = getBaseUrl(ctx); // 取消注释以使用你的实际工具函数
	const base = `${ctx.protocol}://${ctx.host}`;
	ctx.body = {
		progress: `${base}/build/progress/${taskId}`,
		download: `${base}/build/download/${taskId}`,
	};
});

// ✅ 3. SSE 进度订阅（核心整合点：从模拟改为真实订阅）
router.get('/build/progress/:taskId', async (ctx) => {
	const taskId = ctx.params.taskId;
	const task = tasks.get(taskId);

	// 任务不存在 → 直接返回 404
	if (!task) {
		ctx.status = 404;
		ctx.body = { error: 'Task not found' };
		return;
    }
    
	ctx.req.socket?.setNoDelay(true);


	// ✅ 设置 SSE 必需响应头
	ctx.set('Content-Type', 'text/event-stream');
	ctx.set('Cache-Control', 'no-cache');
	ctx.set('Connection', 'keep-alive');
	ctx.set('X-Accel-Buffering', 'no');
	// ✅ 创建 PassThrough 流作为该客户端的专属通道
	const stream = new PassThrough();
	task.clients.add(stream);

	// ✅ 如果任务已经结束，立即发送终态事件并关闭
	if (task.status === 'completed') {
		stream.write(`event: done\ndata: ${JSON.stringify({ taskId })}\n\n`);
		stream.end();
	} else if (task.status === 'failed') {
		stream.write(`event: error\ndata: ${JSON.stringify({ error: task.error })}\n\n`);
		stream.end();
	}
	// status === 'building' → 保持流打开，等待后台 notify 写入

	// ✅ 客户端断开时从连接池移除
	ctx.req.on('close', () => {
		task.clients.delete(stream);
		console.log(`Client disconnected: ${taskId}, remaining: ${task.clients.size}`);
	});

	// ✅ 将 PassThrough 流作为 Koa 响应体（Koa 会自动 pipe 到 res）
	ctx.body = stream;
	// ⚠️ 注意：这里不需要手动 res.writeHead() 或 ctx.body = null
	// Koa 检测到 body 是 Stream 时会自动以流式方式发送响应
});

// ✅ 4. 文件下载（标准二进制流）
router.get('/build/download/:taskId', async (ctx) => {
	const task = tasks.get(ctx.params.taskId);
	if (!task || task.status !== 'completed' || !task.outputPath) {
		ctx.status = task?.status === 'failed' ? 500 : 404;
		ctx.body = { error: task?.error || 'File not ready' };
		return;
	}

	const stat = await fsp.stat(task.outputPath);
	ctx.attachment(`${task.id}.7z`);
	ctx.type = 'application/x-7z-compressed';
	ctx.set('Content-Length', String(stat.size));
	ctx.body = fs.createReadStream(task.outputPath);
});

app.use(router.routes());
app.listen(3000);

app.use(router.routes()).use(router.allowedMethods());

const PORT = 2000;
app.listen(PORT, () => {
	console.log(`✅ 服务已启动：http://${ip}:${PORT}\n`);
	console.log(`✅ build:${os.platform()} => http://${ip}:${PORT}/build`);
});
