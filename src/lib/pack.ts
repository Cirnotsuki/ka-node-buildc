import { path7za } from '7zip-bin';
import path from 'path';
import fs from 'fs/promises';
import { runFile } from '@ka-libs/utils';
import { mkdirp } from 'mkdirp';

interface PackOptions {
	/** 压缩级别 0-9，默认 9 */
	level?: number;
	/** 是否启用多线程，默认 true */
	multiThread?: boolean;
	/** 超时时间(ms)，默认 10 分钟 */
	timeout?: number;
}

export default async function pack(
	name: string,
	sourceDir: string,
	outputDir: string,
	options: PackOptions = {},
): Promise<string> {
	const { level = 9, multiThread = true, timeout = 600_000 } = options;

	// ✅ 安全创建输出目录（递归、无竞态）
	await mkdirp(outputDir);

	// ✅ 修复双 .7z 后缀问题
	const zipName = name.endsWith('.7z') ? name : `${name}.7z`;
	const outputPath = path.resolve(outputDir, zipName);

	// ✅ 直接使用你的 runFile，完全复用其超时/输出捕获/进程管理能力
	const result = await runFile(
		path7za,
		[
			'a',
			outputPath,
			'.',
			`-mx=${level}`,
			multiThread ? '-mmt=on' : '-mmt=off',
			'-y', // 自动确认覆盖，防止交互挂起触发超时
		],
		{
			cwd: sourceDir,
			stdio: 'pipe', // 配合 runFile 的输出捕获
			timeout, // 直接透传，由 runFile 统一处理 SIGTERM/SIGKILL
		},
	);

	// ✅ 利用 runFile 返回的结构化结果做错误判断
	if (result.code !== 0) {
		throw new Error(`7z packing failed (exit ${result.code}): ${result.stderr.trim()}`);
	}

	// ✅ 产物完整性校验（7z 某些异常退出码为 0 但文件为空）
	try {
		const stat = await fs.stat(outputPath);
		if (stat.size === 0) throw new Error('Output file is empty');
	} catch (e: any) {
		await fs.unlink(outputPath).catch(() => {});
		throw new Error(`Pack verification failed: ${e.message}`);
	}

	return outputPath;
}
