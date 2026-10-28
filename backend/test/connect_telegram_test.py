import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[1] / "tools/connect_telegram.py"
spec = importlib.util.spec_from_file_location("connect_telegram", source)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_production_secret_and_menu_use_the_production_target(self):
        token = "123456789:local_test_token_only_123456789"
        target = {"path": setup.ROOT / "wrangler.production.jsonc", "bot": "vash_gruz_by_bot", "account": setup.ACCOUNT_ID, "url": "https://vashgruz-production-api.vashgruz-api.workers.dev", "mini_app": "https://websitepreview26.github.io/vashgruz/"}
        commands = []
        methods = []

        def urlopen(req, timeout):
            method = req.full_url.rsplit("/", 1)[-1]
            methods.append(method)
            results = {
                "getMe": {"id": 123456789, "username": "vash_gruz_by_bot"},
                "getWebhookInfo": {"url": ""},
                "getUpdates": [{"message": {"chat": {"id": -100777, "type": "supergroup", "title": "Production"}}}],
                "getChat": {"id": -100777, "type": "supergroup"},
                "getChatMember": {"status": "administrator"},
                "setChatMenuButton": True,
            }
            if method == "setChatMenuButton":
                menu = json.loads(setup.urllib.parse.parse_qs(req.data.decode())["menu_button"][0])
                self.assertEqual(menu["web_app"]["url"], target["mini_app"])
            return io.StringIO(json.dumps({"ok": True, "result": results[method]}))

        def run(args, **kwargs):
            commands.append(args)
            self.assertNotIn(token, " ".join(args))
            if "whoami" in args:
                data = {"loggedIn": True, "accounts": [{"id": setup.ACCOUNT_ID}]}
            elif "bulk" in args:
                self.assertIn(str(target["path"]), args)
                self.assertEqual(json.loads(kwargs["input"]), {"BOT_TOKEN": token, "TELEGRAM_CHAT_ID": "-100777"})
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
            else:
                self.assertIn(target["url"] + "/health", args[-1])
                data = {"ok": True, "configured": True}
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(data), stderr="")

        output = io.StringIO()
        with patch.object(setup, "connection", return_value=target) as connection, \
                patch.object(setup, "runtime", return_value=["node", "wrangler"]), \
                patch.object(setup.sys.stdin, "isatty", return_value=True), \
                patch.object(setup.getpass, "getpass", return_value=token), \
                patch("builtins.input", side_effect=["", "", "да"]), \
                patch.object(setup.urllib.request, "urlopen", side_effect=urlopen), \
                patch.object(setup.subprocess, "run", side_effect=run), \
                contextlib.redirect_stdout(output):
            setup.main(["--config", "wrangler.production.jsonc"])
            connection.assert_called_once_with("wrangler.production.jsonc")
        self.assertNotIn(token, output.getvalue())
        self.assertIn("@vash_gruz_by_bot", output.getvalue())
        self.assertIn("setChatMenuButton", methods)
        self.assertEqual(len(commands), 3)

    def test_new_bot_cannot_reuse_test_database_or_worker(self):
        config = json.loads((setup.ROOT / "wrangler.jsonc").read_text())
        config["vars"]["BOT_USERNAME"] = "vash_gruz_by_bot"
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "production.json"
            target.write_text(json.dumps(config))
            with patch.object(setup.getpass, "getpass") as prompt, contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    setup.main(["--config", str(target)])
                prompt.assert_not_called()

    def test_production_connection_uses_its_own_bot_and_api(self):
        config = json.loads((setup.ROOT / "wrangler.jsonc").read_text())
        config["vars"]["BOT_USERNAME"] = "vash_gruz_by_bot"
        config["name"] = "vashgruz-production-api"
        config["d1_databases"][0]["database_id"] = "11111111-1111-4111-8111-111111111111"
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "production.json"
            target.write_text(json.dumps(config))
            actual = setup.connection(target)
        self.assertEqual(actual["bot"], "vash_gruz_by_bot")
        self.assertEqual(actual["url"], "https://vashgruz-production-api.vashgruz-api.workers.dev")
        self.assertEqual(setup.connection()["bot"], "vash_gruz_test_bot")

    def test_hidden_token_is_sent_via_stdin_only_and_group_is_discovered(self):
        token = "123456789:" + "local_test_token_only_123456789"
        results = {
            "getMe": {"id": 123456789, "username": setup.BOT_USERNAME},
            "getWebhookInfo": {"url": ""},
            "getUpdates": [{"message": {"chat": {"id": -100123456, "type": "supergroup", "title": "Test orders"}}}],
            "getChat": {"id": -100123456, "type": "supergroup", "title": "Test orders"},
            "getChatMember": {"status": "administrator"},
            "setChatMenuButton": True,
        }

        def urlopen(req, timeout):
            method = req.full_url.rsplit("/", 1)[-1]
            return io.StringIO(json.dumps({"ok": True, "result": results[method]}))

        commands = []

        def run(args, **kwargs):
            commands.append((args, kwargs))
            self.assertNotIn(token, " ".join(args))
            if "whoami" in args:
                stdout = json.dumps({"loggedIn": True, "accounts": [{"id": setup.ACCOUNT_ID}]})
            elif "bulk" in args:
                payload = json.loads(kwargs["input"])
                self.assertEqual(payload["BOT_TOKEN"], token)
                self.assertEqual(payload["TELEGRAM_CHAT_ID"], "-100123456")
                self.assertEqual(kwargs["env"]["CLOUDFLARE_ACCOUNT_ID"], setup.ACCOUNT_ID)
                self.assertEqual(kwargs["env"]["WRANGLER_LOG_PATH"], setup.os.devnull)
                stdout = ""
            else:
                stdout = '{"ok":true,"configured":true}'
            return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

        output = io.StringIO()
        with patch.object(setup, "runtime", return_value=["node", "wrangler"]), \
                patch.object(setup.sys.stdin, "isatty", return_value=True), \
                patch.object(setup.getpass, "getpass", return_value=token), \
                patch("builtins.input", side_effect=["", "", "да"]), \
                patch.object(setup.urllib.request, "urlopen", side_effect=urlopen), \
                patch.object(setup.subprocess, "run", side_effect=run), \
                contextlib.redirect_stdout(output):
            setup.main()
        self.assertNotIn(token, output.getvalue())
        self.assertIn("Готово!", output.getvalue())
        self.assertEqual(len(commands), 3)

    def test_noninteractive_input_is_rejected_before_requesting_token(self):
        with patch.object(setup.sys.stdin, "isatty", return_value=False), \
                patch.object(setup.getpass, "getpass") as prompt, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                setup.main()
            prompt.assert_not_called()


if __name__ == "__main__":
    unittest.main()
