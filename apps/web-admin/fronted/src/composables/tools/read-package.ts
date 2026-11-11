/** 包选择仅在浏览器读取；大小及归档路径的最终校验仍由服务端执行。 */
export async function readPackage(
  file: File,
  maximum: number,
): Promise<string> {
  if (file.size > maximum)
    throw new Error('文件超过大小限制 / Package exceeds size limit')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () =>
      reject(new Error('读取文件失败 / Failed to read file'))
    reader.readAsDataURL(file)
  })
}
