/** 以二进制单位展示文件大小，不把 MIME 或后缀当作脚本执行依据。 */
export function fileSize(bytes: number): string {
  const labels = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes,
    index = 0
  while (value >= 1024 && index < labels.length - 1) {
    value /= 1024
    index++
  }
  return `${value.toFixed(index ? 1 : 0)} ${labels[index]}`
}

/** 仅允许明确的浏览器媒体类型预览；HTML/SVG 等主动内容只下载。 */
export function previewKind(
  mediaType: string,
): 'image' | 'audio' | 'video' | 'text' | 'pdf' | null {
  if (
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)
  )
    return 'image'
  if (mediaType.startsWith('audio/')) return 'audio'
  if (mediaType.startsWith('video/')) return 'video'
  if (
    ['text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(
      mediaType,
    )
  )
    return 'text'
  return mediaType === 'application/pdf' ? 'pdf' : null
}

/** 文件列表使用可读类型名称；原 MIME 仍保留在详情和提示中，不能用于扩大预览权限。 */
export function fileTypeLabel(mediaType: string): string {
  const labels: Record<string, string> = {
    'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      'PowerPoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'Word',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      'Excel',
    'application/pdf': 'PDF',
    'text/plain': '文本',
    'text/markdown': 'Markdown',
    'text/csv': 'CSV 表格',
    'application/json': 'JSON',
    'application/zip': 'ZIP 压缩包',
  }
  return (
    labels[mediaType] ??
    (mediaType.startsWith('image/')
      ? '图片'
      : mediaType.startsWith('audio/')
        ? '音频'
        : mediaType.startsWith('video/')
          ? '视频'
          : '文件')
  )
}
