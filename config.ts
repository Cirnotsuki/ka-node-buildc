import fs from 'fs';
import os from 'os';
import { mkdirp } from 'mkdirp';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class Config {
	private static getDir(name: string) {
		let dirname = __dirname;

		for (;;) {
			const files = fs.readdirSync(dirname);

			if (files.includes(name)) {
				return path.resolve(dirname, name);
			}

			if (files.includes('package.json')) {
				mkdirp.sync(path.join(dirname, name));
				return path.join(dirname, name);
			}

			dirname = path.resolve(dirname, '..');

			if (dirname === '/') break;
		}

		return '';
	}

	static pathes = {
		templates: this.getDir('templates'),
		deps: this.getDir('deps'),
		cache: this.getDir('.cache'),
		uploads: this.getDir('uploads'),
	};

	static deps = {
		location: this.getDir('deps'),

		// phpDev: path.resolve(__dirname, './deps/php-8.3.33/include'),
		openssl: {
			location: './openssl',
			lib: './lib',
			include: './include',

			sslDll: './bin/libssl-3-x64.dll',
			cryptoDll: './bin/libcrypto-3-x64.dll',
		},

		zigCC: {
			version: '0.16.0',
			location: './zigcc',

			hash: {
				win32: '68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e',
				linux: '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00',
			},
		},
	};

	static build = {
		version: 1,
		magic: 'CHNK',
		footerSize: 64,
		platform: os.platform(),
	};
}
