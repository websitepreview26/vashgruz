#!/usr/bin/env python3
"""Interactive reconciliation after checking the real Telegram group.

Used by enable_statuses.py --review; receives its authenticated API caller so
neither the bot token nor the temporary administration key is printed or saved.
"""


def review(call):
    data = call({"action": "deliveries"})
    orders = data.get("orders", [])
    notifications = data.get("notifications", [])
    print("Заявок для сверки: %d. Уведомлений в очереди/на проверке: %d." % (len(orders), len(notifications)))
    choices = {}
    for row in orders:
        print("Заявка %s: %s, попыток %s" % (row["id"], row["state"], row["delivery_attempts"]))
        choices[row["id"]] = ("resolve_order", row)
    for row in notifications:
        print("Уведомление %s: %s (%s)" % (row["id"], row["state"], row["last_error"]))
        if row["state"] in ("uncertain", "failed", "sending"):
            choices[row["id"]] = ("resolve_notification", row)
    if not choices:
        print("Неоднозначных доставок нет. Ожидающие уведомления повторяются автоматически.")
        return
    selected = input("После проверки группы введите полный ID записи (Enter — выход): ").strip()
    if not selected:
        return
    if selected not in choices:
        raise SystemExit("Такой записи нет в списке сверки.")
    action, row = choices[selected]
    result = input("Сообщение найдено в группе? Введите да / нет (Enter — выход): ").strip().lower()
    if result not in ("да", "нет"):
        return
    body = {"action": action, "id": selected, "outcome": "delivered" if result == "да" else "not_delivered"}
    if action == "resolve_order":
        body["expectedUpdatedAt"] = row["updated_at"]
        if result == "да":
            try:
                body["messageId"] = int(input("ID первого сообщения карточки заявки в группе: ").strip())
            except ValueError:
                raise SystemExit("Нужен числовой ID сообщения.")
    body["note"] = input("Что проверено и как установлен результат (5–300 символов): ").strip()
    if not 5 <= len(body["note"]) <= 300:
        raise SystemExit("Результат проверки не записан: неверная длина пояснения.")
    body["confirmation"] = input("Для подтверждения повторите полный ID записи: ").strip()
    if body["confirmation"] != selected:
        raise SystemExit("Подтверждение не совпало. Ничего не изменено.")
    call(body)
    print("Результат сверки сохранён. Повтор разрешён только для проверенной недоставленной записи.")
