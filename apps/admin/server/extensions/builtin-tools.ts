import type { ToolImplementation } from '@superdsh/core/contracts/extensions'
import { officeToolGuide } from '../agents/office-tool-guide.mjs'
import {
  presentationThemes,
  presentationThemeSchema,
} from '../agents/office/design-themes.ts'

export const builtinSourceId = 'superdsh.office'
export const builtinVersion = '2.1.0'
const settings = {
  type: 'object',
  additionalProperties: false,
  properties: {
    companyName: { type: 'string', maxLength: 120, title: '公司名称' },
    title: { type: 'string', maxLength: 160, title: '默认标题' },
  },
}
const office = (
  id: string,
  name: string,
  description: string,
  artifactType: string,
  guide?: string,
): ToolImplementation => ({
  id,
  name,
  description,
  mode: 'office',
  inputSchema: { type: 'object' },
  configurationSchema: settings,
  permissions: ['sessions.run', 'files.write'],
  artifactTypes: [artifactType],
  timeoutSeconds: 300,
  guide,
})

/** Only this shipped package declares its builtins; registry/clients have no tool-name branches. */
export const builtinTools: ToolImplementation[] = [
  {
    id: 'knowledge_search',
    name: '查询公司资料',
    description: '检索授权资料并返回可核对的原文证据。',
    mode: 'read',
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } },
    },
    configurationSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          title: '检索结果数量',
          default: 8,
        },
      },
    },
    permissions: ['sessions.read'],
    artifactTypes: [],
    timeoutSeconds: 90,
  },
  office(
    'spreadsheet_report',
    '处理办公 Excel',
    '检查资料、确认计算口径并生成可编辑 Excel。',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    officeToolGuide.spreadsheet_report,
  ),
  {
    ...office(
      'presentation_report',
      '制作办公 PPT',
      '策划叙事、品牌版式、图表与配图，生成可编辑 PPT。',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      officeToolGuide.presentation_report,
    ),
    configurationSchema: {
      ...settings,
      properties: {
        ...settings.properties,
        designTheme: {
          ...presentationThemeSchema,
          title: '设计主题（可修改的版本资源）',
        },
      },
    },
    configurationPresets: presentationThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      version: theme.version,
      values: { designTheme: theme },
    })),
  },
  office(
    'document_report',
    '制作 Word 文档',
    '根据授权资料生成正式方案、报告、制度、培训手册和会议纪要。',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '先 inspect 资料，再提交 planJson：{title,subtitle?,purpose?,brand?:{company?,accentColor?,fontFace?},tableOfContents?:boolean,sections:[{id,title,level?:1|2|3,pageBreakBefore?:boolean,blocks:[{type:"paragraph",text}|{type:"list",items:string[],ordered?:boolean}|{type:"table",columns:string[],rows:string[][]}|{type:"image",imageId,caption?}|{type:"quote",text,sourceId?}]}]}。标题和正文必须来自用户需求与授权资料。引用图片使用检查返回的 id。流程、组织关系、时间线或对比配图优先调用已授权的 illustration_render 提交结构化 JSON；确认后将返回的 PNG artifactId 作为 inputsJson:[{artifactId,role:"image"}] 输入并 inspect 获取 imageId，无需另配生图模型或 Key。修改时提供 previousArtifactId 并保留未修改章节。',
  ),
  {
    ...office(
      'image_generate',
      '生成配图',
      '用明确配置的生图供应商生成会话素材，不替代精确正文和图表。',
      'image/png',
      'planJson 为 {title,prompt,size?,purpose?}。先 inspect 查询绑定模型支持的尺寸，参考图通过 inputsJson 的 role:image 引用已授权资料。先确认用途与内容，成功后返回的 artifactId 可作为后续 PPT/Word 的 image 输入。不要把正文、公司标识或精确数据交给生图模型绘制。',
    ),
    artifactTypes: ['image/png', 'image/jpeg'],
    configurationSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        modelConfigurationId: {
          type: 'string',
          'x-superdsh-capability': 'image.generate',
          title: '多模态模型配置 ID（留空在新会话绑定时使用全局默认）',
          maxLength: 200,
        },
      },
    },
  },
  {
    ...office(
      'vision_analyze',
      '理解图片',
      '通过已授权的视觉配置理解参考图片，不改变聊天模型。',
      'text/plain',
      '先 inspect 查询视觉配置，将授权图片通过 inputsJson 的 role:image 引用；planJson:{title,prompt,purpose?}。返回文字分析，不能据此声称完成审美质量验收。',
    ),
    artifactTypes: [],
    configurationSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        modelConfigurationId: {
          type: 'string',
          'x-superdsh-capability': 'vision.analyze',
          title: '视觉模型配置 ID（留空使用全局默认）',
          maxLength: 200,
        },
      },
    },
  },
  {
    ...office(
      'illustration_render',
      'JSON 可靠配图',
      '由聊天模型提交结构化内容，工具确定性生成流程、时间线、组织关系、对比和指标配图。',
      'image/png',
      '先用 action=plan 提交 planJson:{title,purpose?,layout:flow|timeline|organization|compare|metrics,nodes:[{id,title,detail?,value?,parentId?}],designTheme?}。2–9 个节点；organization 使用 parentId，单根且最多三层；metrics 的 value 必须来自资料。layout 不需要额外生图模型或 API Key。不能提交 SVG、代码、文件路径、外部 URL。控制中文密度，长内容拆图。确认后得到真实 PNG artifactId，可在 PPT/Word 的 inputsJson 中以 {artifactId,role:"image"} 复用，先 inspect 获取 imageId。配图用于概念、关系与流程；正式表格和数字图表优先保持文档原生可编辑。',
    ),
    timeoutSeconds: 90,
    configurationSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        designTheme: { ...presentationThemeSchema, title: '配图设计主题' },
      },
    },
    configurationPresets: presentationThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      version: theme.version,
      values: { designTheme: theme },
    })),
  },
]
