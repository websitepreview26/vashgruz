#!/usr/bin/env python3
"""Run in a local interactive terminal. Never saves or prints the bot token."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BOT_USERNAME = "vash_gruz_test_bot"
WORKER_URL = "https://vashgruz-api.vashgruz-api.workers.dev"
ACCOUNT_ID = "329067336d53aef4d14658005b3aae45"


def stop(message):
    print(message)
    raise SystemExit(1)


def runtime():
    node = shutil.which("node")
    if not node:
        bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
        if bundled.is_file():
            node = str(bundled)
    wrangler = ROOT / "node_modules/wrangler/bin/wrangler.js"
    if not wrangler.is_file():
        # Reuse an installed CLI on this computer; no credentials from other projects are used.
        candidates = sorted(ROOT.parent.parent.glob("*/node_modules/wrangler/bin/wrangler.js"))
        wrangler = candidates[0] if candidates else wrangler
    if not node or not wrangler.is_file():
        stop("Установите Node.js 24+ и выполните npm install в папке backend.")
    return [node, str(wrangler)]


def connection(config_path=None):
    path = Path(config_path) if config_path else ROOT / "wrangler.jsonc"
    if not path.is_absolute():
        path = ROOT / path
    try:
        config = json.loads(path.read_text())
        bot = config["vars"]["BOT_USERNAME"]
        worker = config["name"]
        account = config["account_id"]
        mini_app = config["vars"]["MINI_APP_URL"]
        database = next(db for db in config["d1_databases"] if db["binding"] == "DB")
        if account != ACCOUNT_ID or not re.fullmatch(r"[A-Za-z0-9_]{5,32}", bot) or not re.fullmatch(r"[a-z0-9-]+", worker):
            raise ValueError()
        if not re.fullmatch(r"[a-f0-9-]{36}", database["database_id"]):
            raise ValueError()
        if urllib.parse.urlsplit(mini_app).scheme != "https" or not urllib.parse.urlsplit(mini_app).hostname:
            raise ValueError()
        if bot.lower() != BOT_USERNAME.lower():
            if database["database_id"] == "e503428e-c384-4ad3-adb7-08e833ba4fa3" or worker == "vashgruz-api":
                stop("Для нового бота нужны отдельные Worker и база: тестовое подключение не менялось.")
    except (OSError, ValueError, KeyError, StopIteration, TypeError):
        stop("Не удалось проверить конфигурацию подключения. Секреты не изменялись.")
    suffix = urllib.parse.urlsplit(WORKER_URL).hostname.split(".", 1)[1]
    return {"path": path.resolve(), "bot": bot, "account": account, "url": "https://" + worker + "." + suffix, "mini_app": mini_app}


def main(argv=()):
    parser = argparse.ArgumentParser(description="Connect a Telegram bot without storing its token locally.")
    parser.add_argument("--config", help="Project-relative Wrangler configuration, resolved inside backend/.")
    args = parser.parse_args(argv)
    target = connection(args.config)
    bot_username, account_id, worker_url = target["bot"], target["account"], target["url"]
    if not sys.stdin.isatty():
        stop("Откройте этот файл в обычном Терминале: токен должен вводиться скрыто.")
    print("Подключение @" + bot_username)
    print("Токен вводится скрыто и не сохраняется в файлы. Для отмены: Ctrl+C.\n")
    cli = runtime() + ["--config", str(target["path"])]
    environ = {**os.environ, "WRANGLER_SEND_METRICS": "false"}
    environ["CLOUDFLARE_ACCOUNT_ID"] = account_id
    # Keep tokens out of Wrangler's debug files as well as out of this script's output.
    environ["WRANGLER_LOG_PATH"] = os.devnull
    environ.pop("CLOUDFLARE_API_TOKEN", None)
    environ.pop("CLOUDFLARE_API_KEY", None)
    environ.pop("CLOUDFLARE_EMAIL", None)
    check = subprocess.run(cli + ["whoami", "--json"], cwd=ROOT, env=environ, capture_output=True, text=True)
    try:
        info = json.loads(check.stdout)
        valid = info.get("loggedIn") and any(a["id"] == account_id for a in info.get("accounts", []))
    except (ValueError, KeyError):
        valid = False
    if check.returncode or not valid:
        stop("Новый аккаунт Cloudflare не подключён к этой папке. Вернитесь в Codex для проверки входа.")

    token = getpass.getpass("Токен бота из BotFather (ввод скрыт): ").strip()
    if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{20,}", token):
        stop("Токен выглядит неполным. Повторите запуск и вставьте токен целиком.")

    def telegram(method, **params):
        url = "https://api.telegram.org/bot" + token + "/" + method
        req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                data = json.load(response)
        except (urllib.error.URLError, ValueError, TimeoutError):
            stop("Telegram API недоступен или отклонил запрос. Проверьте подключение и повторите настройку; токен в чат присылать не нужно.")
        if not data.get("ok"):
            stop("Telegram отклонил запрос. Проверьте токен и права бота в группе.")
        return data["result"]

    me = telegram("getMe")
    if me.get("username", "").lower() != bot_username.lower():
        stop("Это токен другого бота. Нужен токен @" + bot_username + ".")
    print("Бот подтверждён: @" + bot_username)
    webhook = telegram("getWebhookInfo")
    if webhook.get("url") and webhook["url"] != worker_url + "/telegram/webhook":
        stop("У бота подключён другой webhook. Подключение остановлено до изменения секретов; существующий обработчик не менялся.")
    groups = {}
    if not webhook.get("url"):
        print("Напишите в нужной группе /start@" + bot_username)
        input("После отправки команды нажмите Enter здесь… ")
        updates = telegram("getUpdates", limit=100, timeout=0)
        for update in updates:
            message = update.get("message") or update.get("my_chat_member") or {}
            chat = message.get("chat", {})
            if chat.get("type") in ("group", "supergroup"):
                groups[str(chat["id"])] = chat.get("title", "Группа")
    else:
        print("У бота уже есть webhook. Он останется без изменений; ID группы нужно указать вручную.")

    if groups:
        choices = list(groups.items())
        for i, (chat_id, title) in enumerate(choices, 1):
            print("%d. %s (%s)" % (i, title, chat_id))
        selection = input("Номер группы [1]: ").strip() or "1"
        if not selection.isdigit() or not 1 <= int(selection) <= len(choices):
            stop("Неверный номер группы. Повторите запуск.")
        chat_id = choices[int(selection) - 1][0]
    else:
        chat_id = input("ID закрытой группы (отрицательное число), либо Enter для отмены: ").strip()
        if not chat_id:
            stop("Настройка отменена. Добавьте бота в группу и отправьте команду, затем повторите запуск.")
    if not re.fullmatch(r"-\d+", chat_id):
        stop("Нужен числовой ID группы, а не инвайт-ссылка.")
    chat = telegram("getChat", chat_id=chat_id)
    if chat.get("type") not in ("group", "supergroup"):
        stop("Этот чат не является группой.")
    member = telegram("getChatMember", chat_id=chat_id, user_id=me["id"])
    status = member.get("status")
    if status not in ("creator", "administrator", "member", "restricted"):
        stop("Добавьте бота в группу и повторите запуск.")
    permissions = member if status == "restricted" else chat.get("permissions", {})
    if status not in ("creator", "administrator") and (
        permissions.get("can_send_messages") is False or permissions.get("can_send_photos") is False
    ):
        stop("Разрешите боту отправлять сообщения и фотографии в группе.")
    if bot_username.lower() != BOT_USERNAME.lower() and status not in ("creator", "administrator"):
        stop("Для рабочего бота назначьте его администратором группы, чтобы проверять права менеджеров.")
    print("Получатель: " + chat.get("title", chat_id))
    if input("Сохранить подключение в Cloudflare? [да/нет]: ").strip().lower() not in ("да", "д", "yes", "y"):
        stop("Настройка отменена. Секреты не изменялись.")
    payload = json.dumps({"BOT_TOKEN": token, "TELEGRAM_CHAT_ID": chat_id})
    result = subprocess.run(cli + ["secret", "bulk"], input=payload, cwd=ROOT, env=environ, capture_output=True, text=True)
    # Do not forward CLI diagnostics: some versions include request details in debug output.
    del payload
    if result.returncode:
        stop("Cloudflare не подтвердил сохранение секретов. Сообщите об этом в Codex; токен присылать не нужно.")
    telegram("setChatMenuButton", menu_button=json.dumps({"type": "web_app", "text": "Получить оценку", "web_app": {"url": target["mini_app"]}}))
    del token
    try:
        health_check = subprocess.run(
            [cli[0], "-e", "fetch(" + json.dumps(worker_url + "/health") + ",{signal:AbortSignal.timeout(20000)}).then(async r=>{if(!r.ok)throw Error();console.log(await r.text())}).catch(()=>process.exitCode=1)"],
            capture_output=True, text=True, timeout=25,
        )
        health = json.loads(health_check.stdout)
        if health_check.returncode:
            raise ValueError()
    except (ValueError, subprocess.TimeoutExpired):
        stop("Секреты сохранены, но проверка Worker не завершилась. Вернитесь в Codex для проверки.")
    if not health.get("configured"):
        stop("Секреты сохранены. Worker ещё обновляется — сообщите в Codex, проверим готовность.")
    print("\nГотово! Бот и группа подключены. Вернитесь в Codex и напишите «готово».")
    print("Настоящие сообщения в группу во время этой настройки не отправлялись.")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        print("\nНастройка отменена.")
        raise SystemExit(130)
