import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { Converter, ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import { ApiError } from '../../http/api-router.ts'
import { OfficeInputError, type OfficeInputFile } from './types.ts'
import {
  OFFICE_LIMITS,
  readOfficeArchive,
  validateInput,
} from './validation.ts'

const timeoutMs = 60_000
const maxOutputBytes = 16 * 1024 * 1024
const scratchPrefix = 'superdsh-office-preview-'

export interface OfficeAssetPreview {
  name: string
  mediaType: 'application/pdf'
  contentBase64: string
  missingFonts: string[]
}

type ConverterFactory = (options: ConverterOptions) => Promise<Converter>

const loadConverter: ConverterFactory = async (options) => {
  const { createConverter } = await import('@deepseek-ai/libreoffice-kit')
  return createConverter(options)
}

function previewError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof OfficeInputError) return new ApiError(422, error.message)
  const code =
    error && typeof error === 'object' && 'code' in error ? error.code : ''
  if (code === 'timeout')
    return new ApiError(504, '文档预览生成超时，请重试或下载原文件查看')
  if (code === 'input-too-large' || code === 'output-too-large')
    return new ApiError(413, '文档预览超过大小限制，请下载原文件查看')
  if (code === 'invalid-document' || code === 'unsupported-format')
    return new ApiError(422, '文档无法生成预览，请检查文件或下载原文件查看')
  if (code === 'unavailable' || code === 'ERR_MODULE_NOT_FOUND')
    return new ApiError(503, '文档预览组件不可用，请联系管理员或下载原文件查看')
  return new ApiError(500, '文档预览生成失败，请重试或下载原文件查看')
}

async function readPdf(path: string) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 12)
      throw new ApiError(500, '文档预览输出无效，请下载原文件查看')
    if (info.size > maxOutputBytes)
      throw new ApiError(413, '文档预览超过大小限制，请下载原文件查看')
    // Bound allocation and detect output growth without reading an unbounded file.
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const trailing = await handle.read(Buffer.alloc(1), 0, 1, offset)
    if (
      offset !== info.size ||
      trailing.bytesRead ||
      !/^%PDF-\d\.\d/u.test(bytes.subarray(0, 8).toString('ascii')) ||
      !bytes.subarray(-1024).toString('ascii').trimEnd().endsWith('%%EOF')
    )
      throw new ApiError(500, '文档预览输出无效，请下载原文件查看')
    return bytes
  } finally {
    await handle.close()
  }
}

async function removeScratch(directory: string, scratchRoot: string) {
  const target = resolve(directory)
  if (
    dirname(target) !== scratchRoot ||
    !basename(target).startsWith(scratchPrefix)
  )
    throw new Error(
      'Office preview scratch directory escaped its temporary root',
    )
  await rm(target, { recursive: true, force: true })
}

/** One request owns its converter and scratch files; no document worker is retained. */
export class OfficeAssetPreviewRenderer {
  private busy = false
  private readonly createConverter: ConverterFactory
  private readonly timeoutMs: number

  constructor(
    options: { createConverter?: ConverterFactory; timeoutMs?: number } = {},
  ) {
    this.createConverter = options.createConverter ?? loadConverter
    this.timeoutMs = options.timeoutMs ?? timeoutMs
  }

  async render(
    file: OfficeInputFile,
    signal?: AbortSignal,
  ): Promise<OfficeAssetPreview> {
    signal?.throwIfAborted()
    if (this.busy)
      throw new ApiError(503, '正在生成其他文档预览，请稍后重试', {
        code: 'office_preview_busy',
      })
    this.busy = true
    const deadline = new AbortController()
    const timer = setTimeout(() => {
      deadline.abort(
        new ApiError(504, '文档预览生成超时，请重试或下载原文件查看'),
      )
    }, this.timeoutMs)
    timer.unref()
    const stopped = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal
    const scratchRoot = resolve(tmpdir())
    let directory: string | undefined
    let converter: Converter | undefined
    try {
      const extension = validateInput(file, ['.pptx', '.docx'])
      const archive = readOfficeArchive(file)
      if (
        !archive.file(
          extension === '.docx' ? 'word/document.xml' : 'ppt/presentation.xml',
        )
      )
        throw new OfficeInputError('文件内容与 Office 文档格式不匹配')
      stopped.throwIfAborted()
      directory = await mkdtemp(join(scratchRoot, scratchPrefix))
      const inputPath = join(directory, `source${extension}`)
      const outputPath = join(directory, 'preview.pdf')
      await writeFile(inputPath, file.content, {
        flag: 'wx',
        mode: 0o600,
        signal: stopped,
      })
      converter = await this.createConverter({
        timeoutMs: this.timeoutMs,
        maxInputBytes: OFFICE_LIMITS.inputBytes,
        maxOutputBytes,
        maxArchiveEntries: OFFICE_LIMITS.entries,
        maxUncompressedBytes: OFFICE_LIMITS.expandedBytes,
        maxLoadedFontBytes: 128 * 1024 * 1024,
      })
      stopped.throwIfAborted()
      const result = await converter.render({ inputPath, outputPath }, stopped)
      stopped.throwIfAborted()
      const bytes = await readPdf(outputPath)
      stopped.throwIfAborted()
      return {
        name: `${file.filename.slice(0, -extname(file.filename).length)}.pdf`,
        mediaType: 'application/pdf',
        contentBase64: bytes.toString('base64'),
        missingFonts: result.missingFonts,
      }
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted()
      if (deadline.signal.aborted) deadline.signal.throwIfAborted()
      throw previewError(error)
    } finally {
      clearTimeout(timer)
      try {
        try {
          await converter?.dispose()
        } finally {
          if (directory) await removeScratch(directory, scratchRoot)
        }
      } finally {
        this.busy = false
      }
    }
  }
}

const sharedRenderer = new OfficeAssetPreviewRenderer()

export const renderOfficeAssetPreview = (
  file: OfficeInputFile,
  signal?: AbortSignal,
) => sharedRenderer.render(file, signal)
