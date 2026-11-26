import { computed, reactive, ref } from 'vue'
import { pricingApi } from '@/api/billing/pricing-api'
import type { PlanDraft } from '@/types/billing/pricing'
import { catalogAdminApi } from '@/api/billing/catalog-api'
import { useMutation } from '@/composables/use-mutation'
import type { PlanSeries } from '@/types/billing/catalog'
import type { Plan } from '@/types/billing/membership'
import { createUuid } from '@/utils/uuid'

/** 以打开时的修订号发布。先核对草稿，结果未知时以原业务号重试。 */
export function useCatalogEditor(
  series: PlanSeries | null,
  withdraw: boolean,
  saved: (draftOnly: boolean) => void,
  stored?: PlanDraft,
) {
  const base = stored?.payload.terms ?? series?.current ?? series?.latest
  const draft = reactive({
    sku: stored?.scope ?? series?.latest.sku ?? '',
    name: base?.name ?? '',
    kind: base?.kind ?? ('membership' as Plan['kind']),
    termUnit: base?.termUnit ?? ('month' as Plan['termUnit']),
    price: base ? String(base.priceFen / 100) : '',
    points: base ? String(base.points) : '',
    listed: base?.listed ?? true,
    timing: stored?.payload.terms.effectiveAt ? 'scheduled' : 'now',
    date: stored?.payload.terms.effectiveAt
      ? new Date(Date.parse(stored.payload.terms.effectiveAt) + 8 * 3600000)
          .toISOString()
          .slice(0, 16)
      : '',
    reason: stored?.payload.terms.reason ?? '',
  })
  const initial = JSON.stringify(draft)
  const dirty = computed(() => JSON.stringify(draft) !== initial)
  const mutation = useMutation(),
    review = ref(false)
  const priceFen = computed(() => Math.round(Number(draft.price) * 100))
  const epoch = computed(() => Date.parse(draft.date + '+08:00'))
  const termsChanged = computed(() => {
    const actual = series?.current
    return (
      !actual ||
      actual.name !== draft.name.trim() ||
      actual.termUnit !== draft.termUnit ||
      actual.priceFen !== priceFen.value ||
      actual.points !== Number(draft.points) ||
      actual.listed !== draft.listed
    )
  })
  const valid = computed(
    () =>
      !!draft.reason.trim() &&
      (withdraw ||
        (/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(draft.sku.trim()) &&
          !!draft.name.trim() &&
          termsChanged.value &&
          /^\d{1,8}(\.\d{1,2})?$/u.test(draft.price.trim()) &&
          priceFen.value <= 2147483647 &&
          (draft.kind !== 'addon' || priceFen.value > 0) &&
          /^\d+$/u.test(draft.points.trim()) &&
          Number(draft.points) > 0 &&
          Number(draft.points) <= 2147483647 &&
          (series || draft.listed) &&
          (draft.timing === 'now' ||
            (Number.isFinite(epoch.value) && epoch.value > Date.now())))),
  )
  let signature = '',
    key = ''
  let persisted = stored
  let persistedSignature = ''
  async function submit(draftOnly = false) {
    if (mutation.busy.value || !valid.value) return
    if (!draftOnly && !review.value && !withdraw) {
      review.value = true
      return
    }
    const reason = draft.reason.trim(),
      sku = draft.sku.trim()
    const command = {
      reason,
      name: draft.name.trim(),
      expectedRevision: series?.latest.revision ?? 0,
      kind: draft.kind,
      termUnit: draft.termUnit,
      points: Number(draft.points),
      priceFen: priceFen.value,
      listed: draft.listed,
      effectiveAt:
        draft.timing === 'now' ? null : new Date(epoch.value).toISOString(),
    }
    const current = JSON.stringify([sku, command])
    if (signature !== current) {
      signature = current
      key = createUuid()
    }
    const success = await mutation.run(async () => {
      if (withdraw && series?.upcoming)
        await catalogAdminApi.withdraw(sku, series.upcoming.revision, {
          reason,
          businessKey: key,
        })
      else if (draftOnly || stored) {
        const originalMatches =
          stored &&
          persisted?.id === stored.id &&
          !dirty.value &&
          (series?.latest.revision ?? 0) ===
            stored.payload.terms.expectedRevision
        if (
          !persisted ||
          (persistedSignature !== current && !originalMatches)
        ) {
          persisted = await pricingApi.savePlan(sku, persisted?.revision ?? 0, {
            ...command,
            businessKey: key,
          })
          persistedSignature = current
        }
        if (!draftOnly)
          await pricingApi.publish('plan', persisted.id, persisted.revision)
      } else
        await catalogAdminApi.publish(sku, { ...command, businessKey: key })
    })
    if (success) saved(draftOnly)
  }
  return { draft, dirty, review, mutation, valid, submit }
}
