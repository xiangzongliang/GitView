//go:build !windows

package main

import "os/exec"

// hideConsoleWindow 仅 Windows 需要（见 hideconsole_windows.go），
// 其他平台无控制台窗口问题，空实现。
func hideConsoleWindow(cmd *exec.Cmd) {}
