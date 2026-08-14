import { FooterBuffer } from "../core/footerBuffer";
import { BuildC } from "../core/buildc";

/**
 * ArrayBuffer 转 C 数组
 */
export function toBufC(buf: ArrayBuffer) {
	const keyBytes = new Uint8Array(buf);

	return Array.from(keyBytes)
		.map((v) => `0x${v.toString(16).padStart(2, '0')}`)
		.join(', ');
}

export function toBuf(str: string) {
	const arr = str.split(', ').map((hex) => parseInt(hex, 16));
	return new Uint8Array(arr).buffer;
}

export function createFooter(runtimeOffset = 1, runtimeLength = 1, chunksOffset = 1, chunksLength = 1, crc32Runtime = 1, crc32Chunks = 1) {
	const { FOOTER,  Replacement } = BuildC;

	// 构建 64 字节 Footer
	const footer = new FooterBuffer(FOOTER.SIZE);

	// Magic
	footer.writeChar(FOOTER.MAGIC, Replacement.KA_C_FOOTER_MAGIC_NAME);
	// Version
	footer.writeInt(FOOTER.VERSION);
	// Runtime Offset
	footer.writeBigInt(runtimeOffset, Replacement.KA_C_FOOTER_RUNTIME_OFFSET_NAME);
	// Runtime Length
	footer.writeBigInt(runtimeLength, Replacement.KA_C_FOOTER_RUNTIME_LENGTH_NAME);
	// Chunks Offset
	footer.writeBigInt(chunksOffset, Replacement.KA_C_FOOTER_CHUNKS_OFFSET_NAME);
	// Chunks Length
	footer.writeBigInt(chunksLength, Replacement.KA_C_FOOTER_CHUNKS_LENGTH_NAME);
	// CRC32 Runtime
	footer.writeInt(crc32Runtime);
	// CRC32 Chunks
	footer.writeInt(crc32Chunks);

	return footer;
}
