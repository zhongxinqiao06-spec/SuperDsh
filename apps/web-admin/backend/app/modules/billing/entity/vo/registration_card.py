"""注册奖励首登提醒，卡面、面额与截止时间取自已发批次。"""

from datetime import datetime

from app.modules.billing.entity.vo.dto import BillingView


class RegistrationCardNotice(BillingView):
    id: str
    name: str
    image: str
    points: int
    expires_at: datetime
