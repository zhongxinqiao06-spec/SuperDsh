/** Fictional enterprise corpus. IDs and expected sources are independent of model output. */
export const knowledgeAcceptanceDocuments = [
  {
    id: 'expenses',
    text: '财务制度：员工出差报销必须提交正规发票，先由直属经理审批，再交财务复核。',
  },
  {
    id: 'leave',
    text: '人事制度：年假至少提前三个工作日在考勤系统提交申请，由部门负责人审批。',
  },
  {
    id: 'onboarding',
    text: '新员工入职需要身份证复印件、银行卡号和劳动合同，由人事专员建立员工档案。',
  },
  {
    id: 'contracts',
    text: '法务制度：客户合同签署之前必须经过法务审核，任何员工不得擅自修改合同责任条款。',
  },
  {
    id: 'discounts',
    text: '销售政策：销售折扣超过百分之十需要销售总监书面审批，销售人员不得私自承诺额外优惠。',
  },
  {
    id: 'inventory',
    text: '库存制度：仓库每月最后一个工作日进行盘点，库存差异由仓库主管核实并记录原因。',
  },
  {
    id: 'security',
    text: '信息安全：离职员工账号由管理员在离职当天停用，保留业务资料但撤销所有系统访问权限。',
  },
  {
    id: 'procurement',
    text: '采购制度：采购申请必须包含用途、数量与预算，金额超过五千元需总经理审批。',
  },
  {
    id: 'support',
    text: '客户服务：售后投诉在两个工作小时内响应，重大质量问题升级至客服主管并记录处理结果。',
  },
  {
    id: 'travel',
    text: '差旅住宿：普通城市住宿标准每晚三百元，超标住宿需要提前获得部门经理书面许可。',
  },
  {
    id: 'training',
    text: '培训安排：新员工在入职第一周完成信息安全与产品知识培训，通过测验后开通客户数据权限。',
  },
  {
    id: 'payments',
    text: '财务付款：供应商款项必须核对采购订单、收货记录和发票，三项一致后才能安排付款。',
  },
  {
    id: 'backup',
    text: '数据运维：数据库每天凌晨两点自动备份，备份保留三十天，每季度进行恢复演练。',
  },
  {
    id: 'remote',
    text: '办公制度：员工每周可申请一天居家办公，需主管同意且保持工作时间在线响应。',
  },
  {
    id: 'products',
    text: '产品资料：星河协作平台提供项目协同、文档管理和审批流程功能，支持中文与英文界面。',
  },
]

export const knowledgeAcceptanceQueries = [
  ['出差花的钱怎么申请报销？', 'expenses'],
  ['报销要带哪些凭据？', 'expenses'],
  ['休年假要提前多久申请？', 'leave'],
  ['谁审批我的年假？', 'leave'],
  ['新人办理入职要准备什么材料？', 'onboarding'],
  ['与客户签合同前找哪个部门审核？', 'contracts'],
  ['员工可以自己修改合同责任吗？', 'contracts'],
  ['给客户打折超过百分之十由谁批准？', 'discounts'],
  ['仓库什么时候盘点库存？', 'inventory'],
  ['员工离职后系统权限怎么处理？', 'security'],
  ['采购六千元设备需要谁批准？', 'procurement'],
  ['客户投诉后多久必须回应？', 'support'],
  ['出差住酒店每晚预算是多少？', 'travel'],
  ['住宿费用超标怎么办？', 'travel'],
  ['新员工什么时候参加培训？', 'training'],
  ['给供应商付款要核对哪些单据？', 'payments'],
  ['数据库备份保留多长时间？', 'backup'],
  ['公司允许居家办公吗？', 'remote'],
  ['星河协作平台有哪些功能？', 'products'],
  ['软件支持哪几种语言？', 'products'],
]
