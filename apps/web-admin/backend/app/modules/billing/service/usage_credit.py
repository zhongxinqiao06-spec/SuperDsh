"""向任务模块提供同事务的额度预留和结算，以及已确认报价对应的实扣点数。"""

from app.modules.billing.dao.usage_credit import finish_job, reserve_jobs

__all__ = ["chargeable_points", "finish_job", "reserve_jobs"]


def chargeable_points(standard_points: int, *, unlimited: bool) -> int:
    """管理员按原费率留存报价，任务预留与结算均按零点处理。"""
    return 0 if unlimited else standard_points
