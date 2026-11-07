/** DSH's schema DSL describes inputs; the registry validates the complete JSON Schema. */
export function toolParameters(descriptor) {
  if (descriptor.mode === 'read')
    return Object.fromEntries(
      Object.entries(descriptor.inputSchema.properties ?? {}).map(
        ([name, schema]) => [
          name,
          {
            type: ['string', 'number', 'integer', 'boolean'].includes(
              schema.type,
            )
              ? schema.type
              : 'json',
            description: schema.description ?? schema.title ?? name,
            ...(descriptor.inputSchema.required?.includes(name)
              ? { required: true }
              : {}),
          },
        ],
      ),
    )
  if (descriptor.mode === 'action')
    return {
      argumentsJson: {
        type: 'string',
        required: true,
        description:
          '符合工具输入 Schema 的 JSON 对象，先生成方案供用户确认；不可加入凭据或本机路径。',
      },
      planId: { type: 'string', description: '修订已保存方案时指定' },
    }
  return {
    action: {
      type: 'string',
      description:
        'inspect 检查输入；plan 提交生成或修订方案，未确认时不会执行。',
    },
    inputsJson: {
      type: 'string',
      description:
        'JSON 文件引用数组：[{assetId或artifactId或attachmentName,attachmentHash?,role?:input|template|knowledge|image}]，最多10项',
    },
    planJson: {
      type: 'string',
      description:
        '文档或素材方案 JSON；完整结构见工具说明。修订 PPT/Word 可提交 {patch:{baseHash:原方案sha256,changes:[{op:replace|remove|insertAfter,id:原页面或章节id,value:完整新节点}],designTheme?,brand?,title?}}，保持未修改节点不变；先 inspect previousArtifactId 读取原方案。',
    },
    planId: {
      type: 'string',
      description: '修订已保存方案时指定；不传输入可复用原资料',
    },
    previousArtifactId: {
      type: 'string',
      description: '修改已有成果时指定 fileId；生成新版本，保留原文件',
    },
    templateAssetId: {
      type: 'string',
      description: '用户明确选择的绑定模板 ID',
    },
    dataAssetId: {
      type: 'string',
      description: '用户明确选择的资料 ID；不能默认使用示例',
    },
    attachmentName: {
      type: 'string',
      description: '本会话办公附件的完整文件名',
    },
    attachmentHash: {
      type: 'string',
      description: '同名附件消歧用 SHA256 前缀',
    },
    companyName: { type: 'string', description: '公司名称' },
    title: { type: 'string', description: '成果标题' },
  }
}
