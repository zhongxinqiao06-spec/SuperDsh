import { OfficeInputError, type OfficeInputFile } from './types.ts'
import { validateInput } from './validation.ts'

export function imageData(file: OfficeInputFile) {
  const extension = validateInput(file, ['.png', '.jpg', '.jpeg'])
  const bytes = file.content
  let width = 0
  let height = 0
  if (extension === '.png') {
    if (
      bytes.length < 33 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
    )
      throw new OfficeInputError('PNG 图片内容无效')
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
  } else {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
      throw new OfficeInputError('JPEG 图片内容无效')
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]!
      if (marker === 0xda || marker === 0xd9) break
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + length + 2 > bytes.length) break
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5)
        width = bytes.readUInt16BE(offset + 7)
        break
      }
      offset += length + 2
    }
  }
  if (width < 1 || height < 1 || width * height > 40_000_000)
    throw new OfficeInputError('图片尺寸无法读取或超过四千万像素')
  return {
    data: `image/${extension === '.png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`,
    width,
    height,
  }
}
