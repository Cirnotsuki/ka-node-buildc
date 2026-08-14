import path from 'path';
import fs from 'fs';
import os from 'os';
import config from '../../config';
import { build } from '../lib/build';
import { createFooter, toBuf, toBufC } from '../lib/utils';

export class BuildC {
	static platform: 'win32' | 'linux' | 'darwin' | 'macos' = 'win32';

	static FOOTER = {
		VERSION: config.build?.version || 1,
		MAGIC: config.build?.magic || 'CHNK',
		SIZE: config.build?.footerSize || 64,
	};

	static DEPS = {
		cache: '',
		location: config.deps?.location || '',

		openssl: {
			location: config.deps?.openssl?.location || '',
			lib: config.deps?.openssl?.lib || '',
			include: config.deps?.openssl?.include || '',
			sslDll: config.deps?.openssl?.sslDll || '',
			cryptoDll: config.deps?.openssl?.cryptoDll || '',
		},

		zigCC: {
			version: config.deps?.zigCC?.version || '0.16.0',
			location: config.deps?.zigCC?.location || '',

			hash: {
				win32: config.deps?.zigCC?.hash?.win32 || '',
				linux: config.deps?.zigCC?.hash?.linux || '',
			},
		},
	};

	static Replacement = {
		// 记录 runtime chunks 的信息
		KA_C_RUMTIME_HEX: '',
		KA_C_RUMTIME_PATH: '',

		// 记录 footer 信息
		KA_C_FOOTER_STRUCT: '',
		KA_C_FOOTER_MAGIC_NAME: '',

		KA_C_FOOTER_RUNTIME_OFFSET_NAME: '',
		KA_C_FOOTER_RUNTIME_LENGTH_NAME: '',

		KA_C_FOOTER_CHUNKS_OFFSET_NAME: '',
		KA_C_FOOTER_CHUNKS_LENGTH_NAME: '',

		KA_C_FOOTER_SIZE: '',
		KA_C_FOOTER_MAGIC_STR: '',

		// 基础填充信息
		KA_C_BINFILE: '',
		KA_C_TEMPDIR: '',

		KA_C_AES_KEY: '',
		KA_C_AES_IV: '',
		KA_C_AES_TAG: '',
		KA_C_AES_MASK_KEY: '',
		KA_C_AES_MASK_IV: '',
		KA_C_AES_MASK_TAG: '',

		KA_C_AES_DATA_VALUE: '',
		KA_C_AES_DATA_LEN: '0',

		KA_C_TEMP_FILETYPE: '',
		KA_C_TEMP_PREFIX_STR: '',
		KA_C_TEMP_PREFIX_LEN: '',

		KA_C_RUNTIME_DIR_NAME: '',
		KA_C_RUNTIME_EXE_NAME: '',
		KA_C_RUNTIME_EXE_FILETYPE: '',
		KA_C_RUNTIME_IN_SELF_VALUE: '',
		KA_C_RUNTIME_DEBUG_VALUE: '',
	};

	static build = build;
	static toBufC = toBufC;
	static toBuf = toBuf;
	static createFooter = createFooter;
}
