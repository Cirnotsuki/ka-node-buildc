import { path7za } from "7zip-bin";
import { runFile } from "@ka-libs/utils";
import { mkdirp } from "mkdirp";

/**
 * 根据平台选择解压方式
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
	await mkdirp(destDir);

	if (archivePath.endsWith('.zip') || archivePath.endsWith('.7z')) {
		// Windows: 7za
		const result = await runFile(path7za, ['x', archivePath, `-o${destDir}`, '-y', '-bso0', '-bsp0'], {
			stdio: 'inherit',
			timeout: 120_000,
		});
		if (result.code !== 0) throw new Error(`7za exited with code ${result.code}`);
	} else if (archivePath.endsWith('.tar.xz') || archivePath.endsWith('.tar.gz')) {
		// Linux/macOS: 系统 tar
		const result = await runFile('tar', ['xf', archivePath, '-C', destDir], {
			stdio: 'inherit',
			timeout: 120_000,
		});
		if (result.code !== 0) throw new Error(`tar exited with code ${result.code}`);
	} else {
		throw new Error(`Unsupported archive format: ${archivePath}`);
	}
}
