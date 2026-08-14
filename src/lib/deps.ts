
import fs from 'fs';
import fsp from 'fs/promises';
import { pipeline } from 'stream/promises';

import path from 'path';
import { mkdirp } from 'mkdirp';
import { path7za } from '7zip-bin';
import { Transform } from 'stream';
import cliProgress from 'cli-progress';
import { runFile } from '@ka-libs/utils';

import { BuildC } from '../core/buildc';
import { createHash } from 'crypto';
import { extractArchive } from './extractArchive';

const MAX_RETRIES = 5;

function getZigUrl(): string {
	const {
		platform,
		DEPS: { zigCC },
	} = BuildC;

	switch (platform) {
		case 'win32':
			return `https://ziglang.org/download/${zigCC.version}/zig-x86_64-windows-${zigCC.version}.zip`;
		case 'linux':
			// Zig 0.12+ Linux 使用 tar.xz
			return `https://ziglang.org/download/${zigCC.version}/zig-x86_64-linux-${zigCC.version}.tar.xz`;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}
}



function getDepHash(name: 'zigCC') {
	const { platform, DEPS } = BuildC;

	switch (platform) {
		case 'win32':
			return DEPS[name].hash.win32;
		case 'linux':
			return DEPS[name].hash.linux;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}
}
async function notValidateHash(filePath: string, expected: string): Promise<boolean> {
	// ✅ 流式计算 SHA256，内存占用恒定 ~64KB
	const hash = createHash('sha256');
	const stream = fs.createReadStream(filePath);

	for await (const chunk of stream) {
		hash.update(chunk);
	}

	const currentHash = hash.digest('hex');
	console.log(`\nFilePath: ${filePath}\nValidHash:\t${currentHash}\nExpected:\t${expected}`);
	return currentHash !== expected;
}

async function handleDownload(name: 'zigCC', url: string) {
	const { DEPS } = BuildC;

	const cacheDir = DEPS.cache;

	await mkdirp(cacheDir);

	const tmpFile = path.join(cacheDir, `${name}-${Date.now()}.tmp`);

	const response = await fetch(url);

	if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);

	const totalBytes = Number(response.headers.get('content-length')) || 0;

	const bar = new cliProgress.SingleBar({
		format: '📦 Downloading [{bar}] {percentage}% | {value}/{total} MB',
		barCompleteChar: '█',
		barIncompleteChar: '░',
		hideCursor: true,
	});

	// 将字节转为 MB 显示，避免数字过长
	const toMB = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

	bar.start(totalBytes ? Number(toMB(totalBytes)) : 0, 0);

	let downloaded = 0;

	const progressStream = new Transform({
		transform(chunk, _encoding, callback) {
			downloaded += chunk.length;
			bar.update(Number(toMB(downloaded)));
			this.push(chunk); // 关键：必须把数据推下去，否则后续流收不到数据
			callback();
		},
	});

	try {
		await pipeline(response.body, progressStream, fs.createWriteStream(tmpFile));
	} finally {
		bar.stop();
	}

	return tmpFile;
}

/**
 * 获取可用的 zig cc 路径，不存在则自动下载
 */
export async function downloadDep(name: 'zigCC', url: string) {
	const { platform, DEPS } = BuildC;

	const cacheDir = DEPS.cache;

	const hash = getDepHash(name);

	let tmpFile = '';
	for (const file of fs.readdirSync(cacheDir)) {
		if (file.endsWith('.tmp') && file.startsWith(`${name}-`)) {
			tmpFile = path.join(cacheDir, file);
			break;
		}
	}
	if (!tmpFile) {
		tmpFile = await handleDownload(name, url);
	}

	// 校验完整性
	if (await notValidateHash(tmpFile, hash)) {
		await fsp.unlink(tmpFile);
		throw new Error(`Hash verification failed for ${url}`);
	}

	// 解压（使用系统自带工具，无需额外依赖）
	const unpackDir = path.resolve(DEPS.location, DEPS[name].location, platform);

	// 异步解压，按平台自动选择工具
	await extractArchive(tmpFile, unpackDir);
}

export async function getEXE(name: 'zigCC', retry: number = MAX_RETRIES): Promise<string> {
	const { platform, DEPS } = BuildC;

	const url =
		name === 'zigCC'
			? getZigUrl()
			: (() => {
					throw new Error(`Unknown dependency: ${name}`);
				})();

	const unpackDir = path.resolve(DEPS.location, DEPS[name].location, platform);
	// ✅ 兼容 .zip 和 .tar.xz 两种后缀
	const baseDir = path.basename(url).replace(/\.(zip|tar\.xz|tar\.gz)$/, '');
	const exeDir = path.resolve(unpackDir, baseDir);

	if (!fs.existsSync(exeDir)) {
		if (retry <= 0) throw new Error(`Failed to download ${name} after ${MAX_RETRIES} retries`);
		console.log(`📦 ${retry < MAX_RETRIES ? `Retry (${MAX_RETRIES - retry + 1}/${MAX_RETRIES}) ` : ''}Downloading ${url} ...`);
		try {
			await downloadDep(name, url);
		} catch (error) {
			console.error(`Download failed: ${(error as Error).message}`);
			// ✅ 明确的递减退出条件
			return await getEXE(name, retry - 1);
		}
	}

	// ✅ 跨平台查找可执行文件
	const files = fs.readdirSync(exeDir);
	const exeFile = files.find((f) => (platform === 'win32' ? f.endsWith('.exe') : f === 'zig' || f === 'zigcc'));

	if (exeFile) {
		const fullPath = path.resolve(exeDir, exeFile);
		// ✅ Linux 下确保有执行权限
		if (platform !== 'win32') {
			await fsp.chmod(fullPath, 0o755);
		}
		return fullPath;
	}

	// 目录存在但没找到可执行文件，可能是解压不完整
	if (retry > 0) {
		console.warn(`⚠️  Executable not found in ${exeDir}, re-downloading...`);
		await fsp.rm(exeDir, { recursive: true, force: true });
		return await getEXE(name, retry - 1);
	}

	throw new Error(`No executable found in ${exeDir} after ${MAX_RETRIES} retries`);
}
