export default {
	input: './src/index.ts',
	dist: './dist',
	formats: ['cjs', 'esm'],
	external: [
		'path',
		'os',
		'fs',
		'url',
		'fs/promises',
		'stream',
		'stream/promises',
		'cli-progress',
		'7zip-bin',
		'mkdirp',

		'@ka-libs/crypto',
		'@ka-libs/utils',
	],
};
