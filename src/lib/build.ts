import fs from 'fs';
import os from 'os';
import fsp from 'fs/promises';
import path from 'path';
// import FormData from 'form-data';
import nodeFetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { PassThrough } from 'stream';

import { runFile } from '@ka-libs/utils';

import { getEXE } from './deps';

import config from '../../config';
import { BuildC } from '../core/buildc';
import { createFooter } from './utils';
import { uuidv4 } from '@ka-libs/crypto';
import { pipeline } from 'stream/promises';
import pack from './pack';
import { createParser } from 'eventsource-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 获取 PHP include 目录
 */
async function getPhpIncludes() {
	// 优先用 php-config 动态获取，避免硬编码路径
	const result = await runFile('php-config', ['--include-dir'], {
		timeout: 5000,
		stdio: 'pipe',
	});

	if (result.code === 0 && result.stdout.trim()) {
		const base = result.stdout.trim();
		return [base, `${base}/main`, `${base}/TSRM`, `${base}/Zend`];
	}

	// Fallback
	return ['/usr/include/php', '/usr/include/php/main', '/usr/include/php/TSRM', '/usr/include/php/Zend'];
}

/**
 * OpenSSL路径
 */
/**
 * OpenSSL路径
 */
async function getOpenSSL() {
	const { platform, DEPS } = BuildC;

	switch (platform) {
		case 'win32': {
			const opensslDir = path.resolve(DEPS.location, DEPS.openssl.location, platform);

			const opensslLib = path.resolve(opensslDir, DEPS.openssl.lib);

			const file = path.join(opensslLib, 'libcrypto.lib');

			if (!fs.existsSync(file)) {
				throw new Error(`Windows OpenSSL lib not found: ${file}`);
			}

			const SSL_DLL = path.resolve(opensslDir, DEPS.openssl.sslDll);

			const CRYPTO_DLL = path.resolve(opensslDir, DEPS.openssl.cryptoDll);

			return [`-I${path.resolve(opensslDir, DEPS.openssl.include)}`, SSL_DLL, CRYPTO_DLL];
		}

		case 'linux': {
			const includeResult = await runFile('pkg-config', ['--variable=includedir', 'openssl'], {
				timeout: 5000,
				stdio: 'pipe',
			});

			if (includeResult.code !== 0 || !includeResult.stdout.trim()) {
				throw new Error(`Failed to locate OpenSSL include directory:\n${includeResult.stderr}`);
			}

			const libResult = await runFile('pkg-config', ['--variable=libdir', 'openssl'], {
				timeout: 5000,
				stdio: 'pipe',
			});

			if (libResult.code !== 0 || !libResult.stdout.trim()) {
				throw new Error(`Failed to locate OpenSSL library directory:\n${libResult.stderr}`);
			}

			const includeDir = includeResult.stdout.trim();
			const libDir = libResult.stdout.trim();

			DEPS.openssl.include = includeDir;
			DEPS.openssl.lib = libDir;

			// ✅ 同时检查 libcrypto 和 libssl
			const hasCrypto = fs.existsSync(path.join(libDir, 'libcrypto.so')) || fs.existsSync(path.join(libDir, 'libcrypto.a'));
			const hasSsl = fs.existsSync(path.join(libDir, 'libssl.so')) || fs.existsSync(path.join(libDir, 'libssl.a'));

			if (!hasCrypto) {
				throw new Error(`Linux libcrypto not found in: ${libDir}`);
			}
			if (!hasSsl) {
				throw new Error(`Linux libssl not found in: ${libDir}`);
			}

			// ✅ 返回两个库，-lssl 必须在 -lcrypto 前面（链接器单向扫描）
			return [`-I${includeDir}`, `-L${libDir}`, '-lssl', '-lcrypto'];
		}

		case 'darwin': {
			try {
				const result = await runFile('pkg-config', ['--cflags', '--libs', 'openssl'], {
					timeout: 5000,
					stdio: 'pipe',
				});

				if (result.code === 0 && result.stdout.trim()) {
					return result.stdout.trim().split(/\s+/).filter(Boolean);
				}
			} catch {
				// pkg-config 不存在或超时，静默降级
			}

			console.warn('⚠️ pkg-config failed, using fallback OpenSSL paths');

			return ['-I/usr/include', '-L/usr/lib', '-lcrypto'];
		}

		default:
			throw new Error('Unsupported platform');
	}
}

/**
 * 获取 OpenSSL 静态链接所需的额外依赖库
 * OpenSSL 3.x 的 libcrypto.a 引用了 zstd/zlib/jitterentropy 符号，
 * 静态链接时必须显式提供这些库。
 */
async function getOpenSSLDeps(platform: string): Promise<string[]> {
	if (platform !== 'linux') return [];

	const deps: string[] = [];

	// 按依赖顺序排列：被依赖者在前
	const candidates = ['libzstd', 'libz', 'libjitterentropy'];

	for (const lib of candidates) {
		try {
			const result = await runFile('pkg-config', ['--libs', lib.replace(/^lib/, '')], {
				timeout: 3000,
				stdio: 'pipe',
			});
			if (result.code === 0 && result.stdout.trim()) {
				// pkg-config 可能返回 "-L/path -lfoo"，直接拆分使用
				deps.push(...result.stdout.trim().split(/\s+/).filter(Boolean));
				continue;
			}
		} catch {
			// pkg-config 不可用或该库没有 .pc 文件，静默降级
		}

		// Fallback: 直接用 -l 标志
		const libName = lib.replace(/^lib/, '');
		deps.push(`-l${libName}`);
	}

	return deps;
}

/**
 * 创建 binding.gyp
 */
async function createBindingGyp(dirPathC: string) {
	const { Replacement } = BuildC;

	// const phpIncludes = getPhpIncludes();

	const opensslLib = await getOpenSSL();

	const target = Replacement.KA_C_RUNTIME_EXE_NAME;

	const binding: any = {
		targets: [
			{
				target_name: target,

				// 强制指定为独立可执行文件，而非默认的 node addon (dll)
				type: 'executable',
				sources: ['runtime.c'],
				include_dirs: [],
				// defines: ['COMPILE_DL_RUNTIME'],
				conditions: [
					[
						'OS!="win"',
						{
							cflags: ['-O2', '-fPIC', '-std=c11'],
							// ✅ -lssl 在 -lcrypto 前面
							libraries: ['-lssl', '-lcrypto', '-lpthread', '-ldl'],
						},
					],
					// ... win32 保持不变
					[
						'OS=="win"',
						{
							msvs_settings: {
								VCCLCompilerTool: {
									AdditionalOptions: ['/O2', '/std:c11'],
									// 静态链接 CRT，避免目标机器缺少 vcruntime140.dll
									RuntimeLibrary: 0, // 0 = /MT (Release), 1 = /MTd (Debug)
								},
								VCLinkerTool: {
									AdditionalLibraryDirectories: [opensslLib],
								},
							},
							libraries: ['libcrypto.lib'],
						},
					],
				],
			},
		],
	};

	const file = path.resolve(dirPathC, 'binding.gyp');

	await fsp.writeFile(file, JSON.stringify(binding, null, 2));

	console.log('✅ binding.gyp generated');

	// console.log('PHP includes:', phpIncludes);

	console.log('OpenSSL:', opensslLib);

	return file;
}

/**
 * 生成 runtime.c
 */
async function buildRuntimeExe() {
	const { DEPS, Replacement } = BuildC;

	const template = path.resolve(config.pathes.templates, './template.c');

	const fileC = await fsp.readFile(template, 'utf-8');

	const lines = fileC.split('\n');

	const result: string[] = [];

	const reps = Object.keys(Replacement);

	for (const line of lines) {
		let newline = line;

		for (const rep of reps) {
			if (newline.includes(rep)) {
				newline = newline.replaceAll(rep, (Replacement as any)[rep]);
			}
		}

		result.push(newline);
	}

	const output = path.resolve(DEPS.cache, 'runtime.c');

	await fsp.writeFile(output, result.join('\n'), 'utf-8');

	return output;
}

/**
 * 执行 node-gyp（兼容 Win/Linux/macOS，统一使用 runFile）
 */
async function runNodeGyp(cwd: string): Promise<void> {
	const isWin = process.platform === 'win32';

	// Windows 下 node-gyp 通常是 .cmd 脚本，必须通过 shell 执行或通过 npx 调用
	// 使用 npx 可以确保找到项目本地或全局安装的 node-gyp，避免路径问题
	const command = isWin ? 'npx.cmd' : 'npx';
	const args = ['--yes', 'node-gyp', 'rebuild'];

	console.log(`🔨 Run: ${command} ${args.join(' ')}`);

	const result = await runFile(command, args, {
		cwd,
		stdio: 'inherit',
		timeout: 300_000, // node-gyp 编译可能较慢，给 5 分钟超时
	});

	if (result.code !== 0) {
		throw new Error(`node-gyp exited with code ${result.code}`);
	}
}

async function buildExe(outExe: string, cFile: string, nodify: (msg: string) => void | null) {
	const { platform } = BuildC;

	const options = ['cc', '-o', outExe, cFile, '-O2', '-std=c11', '-Wl,--strip-all'];

	// if (platform === 'linux') {
	// 	options.push('-static');
	// }

	const opensslFiles = await getOpenSSL();
	options.push(...opensslFiles);

	switch (platform) {
		case 'win32':
			options.push('-lws2_32', '-lgdi32', '-ladvapi32', '-lcrypt32', '-luser32');
			break;

		case 'linux': {
			// // OpenSSL 3.x 静态链接需要额外的压缩/熵源库
			// const sslDeps = await getOpenSSLDeps(platform);
			// options.push(...sslDeps, '-lpthread', '-ldl');
			// break;
			// ✅ 动态链接只需基础系统库，无需 zstd/z/jitterentropy
			options.push('-lpthread', '-ldl');
			break;
		}
		case 'darwin':
			options.push('-lpthread', '-ldl', '-framework', 'Security', '-framework', 'CoreFoundation');
			break;
	}

	logger(nodify, `⚙️ Build Options: `, options);

	const result = await runFile(await getEXE('zigCC'), options, {
		stdio: 'inherit',
		timeout: 180_000,
	});

	if (result.code !== 0) {
		throw new Error(`zig cc exited with code ${result.code}\n${result.stderr}`);
	}

	try {
		const stat = fs.statSync(outExe);

		if (stat.size === 0) {
			throw new Error('Compiled binary is empty');
		}
	} catch (e) {
		throw new Error(`Output verification failed: ${(e as Error).message}`);
	}
}

function setBuildOptions(opt: any) {
	const footer = opt.footer || {};

	if (['win32', 'linux', 'darwin'].includes(opt.platform)) {
		BuildC.platform = opt.platform.toLowerCase();
	}

	if (typeof opt.cFile === 'string' && fs.existsSync(opt.cFile)) {
		BuildC.cFile = opt.cFile;
	}

	if (typeof footer.version === 'number') {
		BuildC.FOOTER.VERSION = footer.version;
	}

	if (typeof footer.magic === 'string') {
		BuildC.FOOTER.MAGIC = footer.magic;
	}

	if (typeof footer.size === 'number') {
		BuildC.FOOTER.SIZE = footer.size;
	}
}

function logger(notify: (base64: string) => void | null, text: string, data?: any) {
	if (notify) {
		let subfix = '';

		if (data) {
			subfix = JSON.stringify(data, null, 2);
		}

		const encoded = Buffer.from('\n' + text + subfix + '\n', 'utf-8').toString('base64');
		notify(encoded);
	} else {
		console.log('\n' + text, data || '');
	}
}

function sleep(time?: number) {
	if (!time) new Promise((resolve) => setImmediate(resolve));
	return new Promise((resolve) => setTimeout(resolve, time));
}
/**
 * 主编译入口
 */
export async function build(name: string, opt?: Record<string, any>): Promise<Buffer> {
	if (opt && typeof opt === 'object') {
		setBuildOptions(opt);
	}

	const notify = typeof opt?.notify === 'function' ? opt.notify : null;

	const { platform, FOOTER, Replacement } = BuildC;

	const buildDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ka-buildc'));
	const ext = platform === 'win32' ? '.exe' : '';
	const outExe = path.resolve(buildDir, name + ext);

	Replacement.KA_C_FOOTER_STRUCT = createFooter().struct;
	Replacement.KA_C_FOOTER_SIZE = FOOTER.SIZE + '';
	Replacement.KA_C_FOOTER_MAGIC_STR = FOOTER.MAGIC;
	Replacement.KA_C_RUNTIME_EXE_FILETYPE = ext;

	const cFile = BuildC.cFile || (await buildRuntimeExe());

	try {
		// ✅ 给 TCP 栈一个 flush 窗口
		await sleep(100);

		logger(notify, `🔨 Building ${path.basename(outExe)}: `, { platform, cFile });

		await buildExe(outExe, cFile, notify);

		logger(notify, `🎉 Build ${path.basename(outExe)} succeeded`);

		switch (platform) {
			case 'win32': {
				const opensslFiles = await getOpenSSL();

				for (const files = opensslFiles; files.length > 0; ) {
					const file = files.shift();

					if (file?.endsWith('.dll')) {
						logger(notify, `📦 Copying ${path.basename(file)} to build/Release ...`);

						await fsp.copyFile(file, path.resolve(path.dirname(outExe), path.basename(file)));
					}
				}
				break;
			}
			case 'linux': {
				// ✅ 使用 runFile 异步验证链接完整性
				try {
					const lddResult = await runFile('ldd', [outExe], {
						timeout: 5000,
						stdio: 'pipe',
					});

					// 全静态二进制时 ldd 会返回非零码并输出 "not a dynamic executable"
					if (lddResult.stderr.includes('not a dynamic executable') || lddResult.stdout.includes('not a dynamic executable')) {
						logger(notify, '🔒 Fully static binary confirmed — zero runtime dependencies');
					} else if (lddResult.code === 0) {
						const missing = lddResult.stdout.split('\n').filter((l) => l.includes('not found'));
						if (missing.length > 0) {
							throw new Error(`Missing shared libs:\n${missing.join('\n')}`);
						}
						const hasCrypto = lddResult.stdout.includes('libcrypto');

						logger(notify, hasCrypto ? '🔗 Dynamic linking verified — target requires libssl3' : '🔒 Static OpenSSL linked successfully');
					} else {
						throw new Error(`ldd check failed: ${lddResult.stderr}`);
					}
				} catch (e: any) {
					if (!e.message?.includes('not a dynamic executable')) {
						logger(notify, `⚠️  Link verification skipped: ${e.message}`);
					}
				}
				break;
			}
			case 'darwin': {
				try {
					// ✅ macOS 使用 otool 替代 ldd
					const otoolResult = await runFile('otool', ['-L', outExe], { timeout: 5000, stdio: 'pipe' });
					if (otoolResult.code === 0) {
						const hasCrypto = otoolResult.stdout.includes('libcrypto');
						const hasSsl = otoolResult.stdout.includes('libssl');

						logger(notify, hasCrypto || hasSsl ? '🔗 Dynamic OpenSSL linked (macOS)' : '🔒 No dynamic OpenSSL dependency detected');
					}
				} catch (e: any) {
					logger(notify, `⚠️ macOS link verification skipped: ${e.message}`);
				}
				break;
			}
			default:
				break;
		}

		logger(notify, `🎯 Output: build/Release: \n\r\t${outExe}`);
	} catch (e: any) {
		logger(notify, '💥 Build failed:', e.message);
	}

	const zipPath = await pack(uuidv4(), buildDir, buildDir);
	const data = await fsp.readFile(zipPath);

	// 用完后清理
	await fsp.rm(buildDir, { recursive: true, force: true });

	return Buffer.from(data.buffer);
}

function progressHandle(url: string, signal?: AbortSignal): Promise<void> {
	return new Promise(async (resolve, reject) => {
		try {
			const response = await fetch(url, { signal });
			if (!response.ok || !response.body) {
				throw new Error(`SSE failed: ${response.status}`);
			}

			const parser = createParser({
				onEvent: (event: any) => {
					if (event.event === 'done') return resolve();
					if (event.event === 'error') return reject(new Error(event.data));
					try {
						console.log(Buffer.from(JSON.parse(event.data).base64, 'base64').toString());
					} catch {
						console.log(event.data);
					}
				},
			});

			const reader = response.body.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				parser.feed(decoder.decode(value, { stream: true }));
			}

			// 流结束但未收到 done → 异常关闭
			reject(new Error('SSE stream ended without done event'));
		} catch (err) {
			if ((err as Error).name === 'AbortError') return reject(err);
			reject(err);
		}
	});
}

export async function buildRemote(name: string, serveUrl: string) {
	const cFile = await buildRuntimeExe();

	const form = new FormData();
	const fileBuffer = await fsp.readFile(cFile);
	form.append('file', new File([fileBuffer], path.basename(cFile)));
	form.append('name', name);

	try {
		const response = await nodeFetch(serveUrl, {
			method: 'POST',
			body: form, // ✅ node-fetch 自动处理 Content-Length + chunked，无需手动设置
		});
		if (!response.ok) {
			throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
		}

		const { progress, download } = (await response.json()) as any;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5分钟超时

		try {
			await progressHandle(progress);

			const res7z = await nodeFetch(download, {
				method: 'GET',
				signal: controller.signal,
			});
			clearTimeout(timeout);
			// ... 后续 pipeline

			// ✅ 修复2: 增强 filename 解析正则，兼容 RFC 5987 与传统格式
			const contentDisposition = res7z.headers.get('content-disposition');
			let fileName = 'output.7z';
			if (contentDisposition) {
				const match = contentDisposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)"?/i);
				if (match?.[1]) {
					fileName = decodeURIComponent(match[1]);
				}
			}

			// ✅ 修复3: 确保缓存目录存在，避免写入时 ENOENT
			await fsp.mkdir(config.pathes.cache, { recursive: true });
			const output = path.join(config.pathes.cache, fileName);

			// ✅ 流式写入磁盘，内存占用恒定在 ~64KB 缓冲区内
			await pipeline(res7z.body as any, fs.createWriteStream(output));
			console.log(`🎉 Build ${name} succeeded`);
			return output;
		} catch (e) {
			clearTimeout(timeout);
			if ((e as Error).name === 'AbortError') {
				throw new Error('Download timed out or aborted');
			}
			throw e;
		}
	} catch (e: any) {
		throw e;
	}
}
