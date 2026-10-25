import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[1] / "tools/connect_telegram.py"
spec = importlib.util.spec_from_file_location("connect_telegram", source)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_hidden_token_is_sent_via_stdin_only_and_group_is_discovered(self):
        token = "123456789:" + "local_test_token_only_123456789"
        results = {
            "getMe": {"id": 123456789, "username": setup.BOT_USERNAME},
            "getWebhookInfo": {"url": ""},
            "getUpdates": [{"message": {"chat": {"id": -100123456, "type": "supergroup", "title": "Test orders"}}}],
            "getChat": {"id": -100123456, "type": "supergroup", "title": "Test orders"},
            "getChatMember": {"status": "administrator"},
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
