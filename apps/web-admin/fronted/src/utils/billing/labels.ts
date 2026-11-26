/** 已入账的注册来源使用可读名称，未知来源保留账务系统的原值。 */
export function billingLabel(
  value: string,
  tr: (zh: string, en: string) => string,
) {
  switch (value.split(':')[0]) {
    case 'registration':
    case 'registration_grant':
      return tr('注册赠额', 'Registration credit')
    case 'usage_hold':
      return tr('生成预留', 'Generation hold')
    case 'usage_charge':
      return tr('生成扣点', 'Generation charge')
    case 'usage_release':
      return tr('解除预留', 'Hold released')
    case 'membership_grant':
      return tr('会员周期发放', 'Membership credit')
    case 'card':
      return tr('额度卡发放', 'Credit card grant')
    case 'gift':
      return tr('运营赠送', 'Gift')
    case 'compensation':
      return tr('人工补偿', 'Compensation')
    case 'topup':
      return tr('线下加购', 'Offline top-up')
    case 'open':
      return tr('会员开通', 'Activation')
    case 'renew':
      return tr('会员续期', 'Renewal')
    default:
      return value
  }
}

export function signedPoints(value: number) {
  return value > 0 ? '+' + value.toLocaleString() : value.toLocaleString()
}
