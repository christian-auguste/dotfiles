"""Exercise the compiled wizard in a real PTY without installing packages.

Run after `npm run build`: python3 install-wizard/test_wizard.py
"""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class Terminal:
    def __init__(self, platform="ubuntu", installer=None):
        self.directory = tempfile.TemporaryDirectory()
        self.result = Path(self.directory.name) / "selection.json"
        self.output = ""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ["HOME"] = self.directory.name
            os.environ["XDG_CONFIG_HOME"] = str(Path(self.directory.name) / ".config")
            os.environ["TERM"] = "xterm-256color"
            node = shutil.which("node")
            os.execv(node, [node, str(ROOT / "install-wizard/cli.js"),
                           "--platform", platform, "--installer", str(installer or ROOT / "install.sh"),
                           "--result-file", str(self.result)])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    def wait_for(self, text, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if text in ANSI.sub("", self.output):
                return ANSI.sub("", self.output)
            if select.select([self.fd], [], [], 0.1)[0]:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                self.output += chunk.decode("utf-8", errors="replace")
        raise AssertionError(f"Missing {text!r} in terminal output:\n{ANSI.sub('', self.output)[-6000:]}")

    def press(self, keys, expect):
        self.output = ""
        os.write(self.fd, keys.encode())
        return self.wait_for(expect)

    def exit_status(self):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.pid = None
                return os.waitstatus_to_exitcode(status)
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.output += os.read(self.fd, 65536).decode("utf-8", errors="replace")
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
        raise AssertionError("Wizard did not exit")

    def close(self):
        if self.pid is not None:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        os.close(self.fd)
        self.directory.cleanup()


class WizardChecks(unittest.TestCase):
    def start(self, platform="ubuntu", installer=None):
        terminal = Terminal(platform, installer)
        self.addCleanup(terminal.close)
        terminal.wait_for("Choose a starting profile")
        return terminal

    def test_drafts_back_editing_and_explicit_approval(self):
        terminal = self.start()
        terminal.press("\x1b[A\t", "Select software to install")
        # Clear the preset, then select the whole Shell group.
        terminal.press(" \x1b[B ", "Select software to install")
        terminal.press("\t", "Select dotfile configs")
        terminal.press(" \x1b[B ", "Select dotfile configs")
        terminal.press("\t", "Choose login shell")
        terminal.press("\x1b[B\t", "Review installation")

        # Back crosses multiple stages without resetting the Personal draft.
        terminal.press("\x1b[Z", "Choose login shell")
        terminal.press("\x1b[Z", "Select dotfile configs")
        terminal.press("\t", "Choose login shell")
        terminal.press("\t", "Review installation")

        terminal.press("\r", "Choose a starting profile")
        terminal.press("\x1b[Z", "Review installation")

        # Customize Server independently, then return to Personal.
        terminal.press("\r", "Choose a starting profile")
        terminal.press("\x1b[B\t", "Select software to install")
        terminal.press(" \t", "Select dotfile configs")
        terminal.press(" \t", "Choose login shell")
        terminal.press("\x1b[B\t", "Review installation")
        terminal.press("\r", "Choose a starting profile")
        terminal.press("\x1b[A\t", "Select software to install")
        terminal.press("\t", "Select dotfile configs")
        terminal.press("\t", "Choose login shell")
        terminal.press("\t", "Review installation")

        # Directly edit one package, then return straight to review.
        terminal.press("\x1b[B\r", "Select software to install")
        terminal.press("\x1b[B\x1b[C\x1b[B\x1b[B\x1b[B ", "Select software to install")
        terminal.press("\t", "Review installation")
        for _ in range(4):
            terminal.press("\t", "Review installation")
            self.assertFalse(terminal.result.exists(), "Tab must never approve installation")
        os.write(terminal.fd, b"\r")
        self.assertEqual(terminal.exit_status(), 0, terminal.output)
        selection = json.loads(terminal.result.read_text())
        self.assertEqual(selection["profile"], "personal")
        self.assertEqual(set(selection["packages"]), {"node", "zsh", "starship"})
        self.assertEqual(selection["stow"], ["agents"])
        self.assertFalse(selection["setLoginShell"])

    def test_new_run_uses_defaults_and_cancellation_writes_nothing(self):
        terminal = self.start("darwin")
        terminal.press("\t", "Select software to install")
        terminal.press(" ", "Select software to install")
        terminal.press("\t", "Select dotfile configs")
        os.write(terminal.fd, b"\x03")
        self.assertEqual(terminal.exit_status(), 130, terminal.output)
        self.assertFalse(terminal.result.exists())

        fresh = self.start("darwin")
        fresh.press("\t", "Select software to install")
        fresh.press("\t", "Select dotfile configs")
        fresh.press("\t", "Choose login shell")
        fresh.press("\t", "Review installation")
        fresh.press("\x1b[B\x1b[B\x1b[B\x1b[B", "Review installation")
        os.write(fresh.fd, b"\r")
        self.assertEqual(fresh.exit_status(), 0, fresh.output)
        selection = json.loads(fresh.result.read_text())
        self.assertIn("ollama", selection["packages"])
        self.assertIn("ghostty", selection["packages"])
        self.assertIn("pi-ollama", selection["stow"])
        self.assertTrue(selection["setLoginShell"])

    def test_failed_plan_cannot_be_approved(self):
        with tempfile.TemporaryDirectory() as directory:
            # The actual planner must fail because this copy has no Brewfile.
            installer = Path(directory) / "install.sh"
            shutil.copy2(ROOT / "install.sh", installer)
            terminal = self.start(installer=installer)
            terminal.press("\t\t\t\t", "Review installation")
            terminal.press("\x1b[B\x1b[B\x1b[B\x1b[B", "[blocked]")
            terminal.press("\r", "[blocked]")
            self.assertFalse(terminal.result.exists())
            os.write(terminal.fd, b"\x03")
            self.assertEqual(terminal.exit_status(), 130, terminal.output)



if __name__ == "__main__":
    unittest.main()
