/** 官网使用虚构展示数据；业务能力不绑定这些场景或助手。 */
export const websiteScenarios = [
  {
    name: ['经营分析', 'Business analytics'],
    title: [
      '从一张销售表，看见下一步增长。',
      'See the next opportunity in your sales data.',
    ],
    text: [
      '读取销售明细，按区域与产品汇总，识别值得关注的变化。把核对后的数据，交付为可继续编辑的经营报表。',
      'Summarize sales by region and product, verify changes, and deliver an editable report.',
    ],
    steps: [
      ['带入销售明细与分析口径', 'Bring sales data and definitions'],
      ['按业务规则计算与检查', 'Calculate and verify business rules'],
      ['交付 Excel 报表与分析结论', 'Deliver an Excel report and findings'],
    ],
  },
  {
    name: ['企业汇报', 'Business presentation'],
    title: [
      '用企业的表达，讲清楚业务的价值。',
      'Tell the story of your business in your own style.',
    ],
    text: [
      '将公司资料与经营结果组织成清晰叙事，沿用企业模板，从业绩回顾到行动计划，交付可编辑的汇报文件。',
      'Turn company knowledge and results into a clear story using your templates and editable slides.',
    ],
    steps: [
      ['选择企业资料与汇报模板', 'Select knowledge and templates'],
      ['组织数据、观点与行动建议', 'Organize data, insights and actions'],
      ['检查版式并生成 PPTX', 'Review the layout and deliver PPTX'],
    ],
  },
  {
    name: ['企业知识', 'Company knowledge'],
    title: [
      '每一个好答案，都能找到它的依据。',
      'Every good answer has a source.',
    ],
    text: [
      '围绕企业制度与产品资料回答问题，附上来源供员工核对。资料没有覆盖的内容，明确说明，让信息更可靠。',
      'Answer questions using your policies and product documents with verifiable sources and explicit gaps.',
    ],
    steps: [
      ['选择已上传的企业制度', 'Select company policies'],
      ['检索相关条款与上下文', 'Retrieve relevant clauses and context'],
      ['回答问题并提供资料来源', 'Answer with source references'],
    ],
  },
] as const
export const websiteFaqs = [
  [
    '星桥智能平台适合什么样的企业？',
    'Who is Starbridge for?',
    '适合已经积累了业务文档、报表模板和工作规范，希望将它们用于日常 AI 工作的团队。可以先从经营分析、企业汇报、制度查询等边界清晰的场景开始，再逐步扩展。',
    'Teams with business documents, templates and working practices can start with a clear use case and expand over time.',
  ],
  [
    '可以使用我们自己的资料、模板和模型吗？',
    'Can we use our own documents, templates and models?',
    '可以。管理员选择资料、模板、技能、模型和授权工具，组合业务智能体。模板先按实际字段与版式适配，确认样例效果后再投入使用。',
    'Yes. Authorized administrators combine your resources and validate templates with representative examples.',
  ],
  [
    '生成的文件可以继续编辑吗？',
    'Are generated files editable?',
    '可以。办公成果以 Excel 和 PPTX 等可编辑文件交付，可继续核对数据、调整内容和版式。官网展示使用虚构数据；实际文件由你在工作台发起的任务生成。',
    'Yes. Excel and PPTX deliverables remain editable. This website uses fictional examples; real files come from your workspace tasks.',
  ],
  [
    '企业共享、钉钉和企业微信支持到什么程度？',
    'What about enterprise sharing, DingTalk and WeCom?',
    '企业级成员共享、部门授权和钉钉／企业微信接入属于分阶段交付范围。连接企业应用前，需要完成应用授权、身份映射及联调；具体开放能力以实际部署版本为准。',
    'These integrations are delivered in stages and require application authorization, identity mapping and verification for your deployment.',
  ],
  [
    '企业可以自己维护资料和智能体吗？',
    'Can we maintain our own resources and agents?',
    '可以由授权人员维护资料、模板、技能和智能体，把新的业务经验持续补充进平台。软件交付与适配服务、模型调用、存储和运行资源分别明确范围，费用以具体交付方案为准。',
    'Authorized staff can maintain knowledge, templates, skills and agents. Delivery services, model calls, storage and runtime resources have separately agreed scopes.',
  ],
] as const
export const websiteScreens = [
  {
    src: '/images/website/desktop-workbench.webp',
    title: ['桌面工作台', 'Desktop workspace'],
    size: [1440, 940],
  },
  {
    src: '/images/website/mobile-workbench.webp',
    title: ['手机工作台', 'Mobile workspace'],
    size: [390, 844],
  },
  {
    src: '/images/website/agents-desktop.webp',
    title: ['智能体管理', 'Agent management'],
    size: [1440, 940],
  },
] as const
