import { sha256 } from '@ka-libs/crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { mkdirp } from 'mkdirp';
import { path7za } from '7zip-bin';
import { spawnSync } from 'child_process';
import cliProgress from 'cli-progress';
import { Transform } from 'stream';
import { BuildC } from '../core/buildc';

const ExcludeFiles = new Set();
function getZigUrl(): string {
	const {
		platform,
		DEPS: { zigCC },
	} = BuildC;

	let target = '';
	if (platform === 'win32') {
		target = 'x86_64-windows';
	} else if (platform === 'linux') {
		target = 'x86_64-linux';
	} else {
		throw new Error(`Unsupported platform: ${platform}`);
	}

	return `https://ziglang.org/download/${zigCC.version}/zig-${target}-${zigCC.version}.zip`;
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
	const content = await fsp.readFile(filePath);
	const currentHash = await sha256(content);
	console.log(`\n\nFilePath: ${filePath}\nValidHash:\t${currentHash}\nExpected:\t${expected}`);
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
	const toMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

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
		if (file.endsWith('.tmp') && file.startsWith(name)) {
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

	await mkdirp(unpackDir);

	const result = spawnSync(path7za, ['x', tmpFile, `-o${unpackDir}`, '-y', '-bso0', '-bsp0'], {
		stdio: 'inherit',
	});

	if (result.status !== 0) {
		throw new Error(`7za exited with code ${result.status}`);
	}
}

export async function getEXE(name: 'zigCC', retry?: number) {
	const { platform, DEPS } = BuildC;

	let url = '';
	switch (name) {
		case 'zigCC':
			url = getZigUrl();
			break;
		default:
			throw new Error(`Unknown dependency: ${name}`);
	}
	const unpackDir = path.resolve(DEPS.location, DEPS[name].location, platform);
	const baseDir = path.basename(url, '.zip');

	const exeDir = path.resolve(unpackDir, baseDir);

	if (typeof retry === 'number' || !fs.existsSync(exeDir)) {
		console.log(`📦 ${Number(retry) > 0 ? 'Retry ' : ''}Downloading ${url} ...`);
		try {
			await downloadDep(name, url);
		} catch (error) {
			console.error(`Download failed: ${error}`);

			return await getEXE(name, 5);
		}
	}

	const files = fs.readdirSync(exeDir);

	for (const file of files) {
		if (file.endsWith('.exe')) {
			return path.resolve(exeDir, file);
		}
	}

	if (typeof retry === 'undefined' || retry > 1) {
		return await getEXE(name, (retry ?? 5) - 1);
	}

	throw new Error(`No executable found in ${unpackDir}`);
}
