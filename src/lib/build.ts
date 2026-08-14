import fs from 'fs';
import os from 'os';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import child_process from 'child_process';
import { getEXE } from './deps';
import { runFile } from '../../../ka-utils/src/lib/run-file';
import { FooterBuffer } from '../core/footerBuffer';

import config from '../../config';
import { BuildC } from '../core/buildc';
import { createFooter } from './utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 获取 PHP include 目录
 */
// function getPhpIncludes() {
// 	const platform = Runtime.settings.platform.toLowerCase();

// 	// Windows php-sdk
// 	if (platform === 'win32') {
// 		const phpDev = config.deps.phpDev ?? process.env.PHP_DEV_PATH;

// 		const phpHeader = path.join(phpDev, 'main', 'php.h');

// 		if (!fs.existsSync(phpHeader)) {
// 			throw new Error(`Windows: php.h not found: ${phpHeader}`);
// 		}

// 		return [
// 			phpDev,
// 			path.resolve(phpDev, 'main'),
// 			path.resolve(phpDev, 'TSRM'),
// 			path.resolve(phpDev, 'Zend'),
// 		];
// 	}

// 	// Linux php-dev
// 	else {
// 		const includes = [
// 			'/usr/include/php',
// 			'/usr/include/php/main',
// 			'/usr/include/php/TSRM',
// 			'/usr/include/php/Zend',
// 		];

// 		const exists = fs.existsSync('/usr/include/php/main/php.h');

// 		if (!exists) {
// 			throw new Error('Linux: php-dev not installed. Run: sudo apt install php-dev');
// 		}

// 		return includes;
// 	}
// }

/**
 * OpenSSL路径
 */
function getOpenSSL() {
	const { platform, DEPS } = BuildC;

	switch (platform) {
		case 'win32':
			const opensslDir = path.resolve(DEPS.location, DEPS.openssl.location, platform);

			const opensslLib = path.resolve(opensslDir, DEPS.openssl.lib) ?? process.env.OPENSSL_LIB_PATH;

			const file = path.join(opensslLib, 'libcrypto.lib');

			if (!fs.existsSync(file)) {
				throw new Error(`Windows OpenSSL lib not found: ${file}`);
			}

			const SSL_DLL = path.resolve(opensslDir, DEPS.openssl.sslDll);
			const CRYPTO_DLL = path.resolve(opensslDir, DEPS.openssl.cryptoDll);

			return [`-I${path.resolve(opensslDir, DEPS.openssl.include)}`, SSL_DLL, CRYPTO_DLL];

		case 'linux':
		case 'darwin':
			return [];
		default:
			throw new Error('Unsupported platform');
	}
}

/**
 * 创建 binding.gyp
 */
async function createBindingGyp(dirPathC: string) {
	const { Replacement } = BuildC;

	// const phpIncludes = getPhpIncludes();

	const opensslLib = getOpenSSL();

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
							ldflags: ['-static'], // Linux/macOS 也建议静态链接
							libraries: ['-lcrypto'],
						},
					],
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
 * 执行 node-gyp
 */
function runNodeGyp(cwd: string) {
	return new Promise((resolve, reject) => {
		const isWin = process.platform === 'win32';

		const command = isWin ? 'cmd.exe' : 'node-gyp';

		const args = isWin ? ['/c', 'node-gyp.cmd', 'rebuild'] : ['rebuild'];

		console.log('Run:', command, args.join(' '));

		const child = child_process.spawn(command, args, {
			cwd,
			stdio: 'inherit',
			shell: false,
		});

		child.on('error', (err) => {
			console.error('spawn error:', err);
			reject(err);
		});

		child.on('close', (code) => {
			if (code === 0) {
				resolve(1);
			} else {
				reject(new Error(`node-gyp exited ${code}`));
			}
		});
	});
}

async function buildExe(outExe: string, cFile: string) {
	const { platform } = BuildC;

	const options = ['cc', '-o', outExe, cFile, '-O2', '-Wl,--strip-all'];

	options.push(...getOpenSSL());

	if (platform === 'win32') {
		// Windows GNU 工具链还需要这些系统库
		options.push('-lws2_32', '-lgdi32', '-ladvapi32', '-lcrypt32', '-luser32');
	}

	const result = await runFile(await getEXE('zigCC'), options, {
		stdio: 'inherit', // 捕获输出以便在失败时抛出详细错误
		timeout: 120_000, // 2 分钟超时
	});

	if (result.code !== 0) {
		throw new Error(`zig cc exited with code ${result.code}\n${result.stderr}`);
	}

	// 验证产物
	try {
		const stat = fs.statSync(outExe);
		if (stat.size === 0) throw new Error('Compiled binary is empty');
	} catch (e) {
		throw new Error(`Output verification failed: ${(e as Error).message}`);
	}
}

function setBuildOptions(opt: any) {
	const footer = opt.footer || {};

	if (['win32', 'linux', 'macos'].includes(opt.platform)) {
		BuildC.platform = opt.platform.toLowerCase();
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

/**
 * 主编译入口
 */
export async function build(outExe: string, opt?: any) {
	if (opt && typeof opt === 'object') {
		setBuildOptions(opt);
	}

	const { platform, FOOTER, DEPS, Replacement } = BuildC;

	DEPS.cache = await fsp.mkdtemp(path.join(os.tmpdir(), 'ka-buildc'));

	const ext = platform === 'win32' ? '.exe' : '';

	console.log(`🔨 Target platform: ${platform}`);

	Replacement.KA_C_FOOTER_STRUCT = createFooter().struct;
	Replacement.KA_C_FOOTER_SIZE = FOOTER.SIZE + '';
	Replacement.KA_C_FOOTER_MAGIC_STR = FOOTER.MAGIC;
	Replacement.KA_C_RUNTIME_EXE_FILETYPE = platform === 'win32' ? '.exe' : '';

	const cFile = await buildRuntimeExe();

	try {
		console.log(`\n Building ${path.basename(outExe)} ...`);

		await buildExe(outExe, cFile);

		console.log(`\n🎉 Build ${path.basename(outExe)} succeeded`);

		for (const files = getOpenSSL(); files.length > 0; ) {
			const file = files.shift();

			if (file?.endsWith('.dll')) {
				console.log(`📦 Copying ${path.basename(file)} to build/Release ...`);
				await fsp.copyFile(file, path.resolve(path.dirname(outExe), path.basename(file)));
			}
		}
		console.log(`Output: build/Release/${Replacement.KA_C_RUNTIME_EXE_NAME}${ext}`);
	} catch (e: any) {
		console.error('\n💥 Build failed:', e.message);
		throw e;
	} finally {
		// 用完后清理
		await fsp.rm(DEPS.cache, { recursive: true, force: true });
	}
}
