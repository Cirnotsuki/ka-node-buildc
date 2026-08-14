import { generateVariableName } from '../../../wp-php-merge/src/utils/helper';

type FooterPos = number;
type FooterStructType = 'char' | 'uint8_t' | 'uint16_t' | 'uint32_t' | 'uint64_t';
type FooterStructName = string;
type FooterStructLength = number;

export class FooterBuffer {
	private _buffer: Buffer<ArrayBuffer>;
	size: number;

	private pos: number = 0;

	private structRecord: Map<FooterPos, [FooterStructType, FooterStructName, FooterStructLength]> =
		new Map();

	constructor(size: number) {
		if (size <= 0 || !Number.isInteger(size)) {
			throw new Error('Footer size must be a positive integer');
		}
		if (size % 8 !== 0) {
			throw new Error('Footer size must be a multiple of 8');
		}
		this.size = size;
		this._buffer = Buffer.alloc(size);
	}

	get struct() {
		const arr: Array<[FooterStructType, FooterStructName, FooterStructLength] | undefined> =
			new Array(this.size);

		for (let i = 0; i < this.size; i++) {
			arr[i] = this.structRecord.get(i);
		}

		const result = arr
			.filter((item) => typeof item !== 'undefined')
			.map(([type, name, length]) => {
				if (type === 'char') {
					return `char ${name}[${length}];`;
				}
				return `${type} ${name};`;
			});

		if (this.size > this.pos) {
			result.push(`uint8_t reserved[${this.size - this.pos}];`);
		}
		return result.join('\n');
    }
    
    get buffer() {
        return new Uint8Array(this._buffer.buffer);
    }

	/** 每种类型的实际字节大小 */
	static UNPACK_SYMBOL: Record<FooterStructLength, string> = {
		1: 'C',
		2: 'v',
		4: 'V',
		8: 'P',
	};

	get unpacker() {
		const arr: Array<[FooterStructType, FooterStructName, FooterStructLength] | undefined> =
			new Array(this.size);

		for (let i = 0; i < this.size; i++) {
			arr[i] = this.structRecord.get(i);
		}

		return arr
			.filter((item) => typeof item !== 'undefined')
			.map(([type, name, length]) => {
				if (type === 'char') {
					return `A${length}${name}`;
				}
				return `${FooterBuffer.UNPACK_SYMBOL[length]}${name}`;
			})
			.join('/');
	}

	/** 每种类型的实际字节大小 */
	static TYPE_SIZE: Record<FooterStructType, number> = {
		char: 1,
		uint8_t: 1,
		uint16_t: 2,
		uint32_t: 4,
		uint64_t: 8,
	};

    unpack(buffer?: Buffer) {
        if (!buffer) {
            buffer = this._buffer;
        }
		const result: Record<string, any> = {};

		for (const [pos, [type, name, length]] of this.structRecord) {
			switch (type) {
				case 'char':
					result[name] = buffer.toString('ascii', pos, pos + length).replace(/[\0 ]+$/, '');
					break;
				case 'uint8_t':
					result[name] = Number(buffer.readUInt8(pos));
					break;
				case 'uint16_t':
					result[name] = Number(buffer.readUInt16LE(pos));
					break;
				case 'uint32_t':
					result[name] = Number(buffer.readUInt32LE(pos));
					break;
				case 'uint64_t':
					result[name] = Number(buffer.readBigUInt64LE(pos));
					break;
				default:
					break;
			}
        }
        
        return result;
	}

	write(
		data: string | number | bigint,
		type: FooterStructType,
		name: FooterStructName,
		length: number,
	) {
		// 按类型实际大小计算，不再强制 4 字节对齐
		const byteLen = type === 'char' ? length : FooterBuffer.TYPE_SIZE[type];

		if (this.pos + byteLen > this.size) {
			throw new Error(
				`Footer overflow: writing ${byteLen} bytes at offset ${this.pos} exceeds size ${this.size}`,
			);
        }
        
        const buffer = this._buffer;

		if (typeof data === 'string') {
			buffer.write(data, this.pos, byteLen, 'ascii');
		} else if (type === 'uint8_t') {
			buffer.writeUInt8(Number(data), this.pos);
		} else if (type === 'uint16_t') {
			buffer.writeUInt16LE(Number(data), this.pos);
		} else if (type === 'uint32_t') {
			buffer.writeUInt32LE(Number(data), this.pos);
		} else if (type === 'uint64_t') {
			buffer.writeBigUInt64LE(BigInt(data), this.pos);
		}

		this.structRecord.set(this.pos, [type, name || generateVariableName(), length]);
		this.pos += byteLen;
	}

	writeChar(data: string, name: FooterStructName = '') {
		if (data.length > 8) {
			throw new Error('Char data length must be less than or equal to 8');
		}
		if (data.length > 4) {
			this.write(data, 'char', name, 8);
		} else {
			this.write(data, 'char', name, 4);
		}
	}

	writeInt(data: number, name: FooterStructName = '') {
		this.write(data, 'uint32_t', name, 4);
	}

	writeBigInt(data: number, name: FooterStructName = '') {
		this.write(BigInt(data), 'uint64_t', name, 8);
	}
}
