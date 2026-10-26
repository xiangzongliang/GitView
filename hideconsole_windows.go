//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideConsoleWindow 防止生产模式下（-ldflags "-H windowsgui"，进程本身没有
// 控制台）派生 git / powershell 等控制台子系统子进程时，每次弹出一个黑色
// 控制台窗口（打开仓库时连续执行多条 git 命令会连环闪框）。
// CREATE_NO_WINDOW 给子进程分配一个不可见控制台，stdout/stderr 管道捕获
// 与退出码均不受影响；开发模式下进程自带控制台，子进程直接继承，本就不闪。
func hideConsoleWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
