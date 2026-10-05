package main

import "strings"

// AppService exposes application-level information (version, author) to the
// frontend settings panel.
type AppService struct{}

// appVersion mirrors build/config.yml -> info.version.
//
// It is a var (not a const) so release builds can inject the real version:
//
//	-ldflags "-X main.appVersion=x.y.z"
//
// The same value is reported to the update manifest, so it must match the
// release tag exactly (no "v" prefix).
var appVersion = "0.1.5"

// appAuthor is the author shown in the About section.
const appAuthor = "xiangzongliang"

// Version returns the application version string.
func (s *AppService) Version() string {
	return appVersion
}

// Author returns the application author.
func (s *AppService) Author() string {
	return appAuthor
}

// GitVersion returns the installed git version without the leading
// "git version " prefix (e.g. "2.50.1 (Apple Git-155)"). Empty when git is
// unavailable.
func (s *AppService) GitVersion() string {
	out, err := runGit("", "--version")
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(strings.TrimSpace(out), "git version ")
}
