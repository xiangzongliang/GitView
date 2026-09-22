package main

// AppService exposes application-level information (version, author) to the
// frontend settings panel.
type AppService struct{}

// appVersion mirrors build/config.yml -> info.version.
const appVersion = "0.0.1"

// appAuthor is the author shown in the About section.
const appAuthor = "xiangzl"

// Version returns the application version string.
func (s *AppService) Version() string {
	return appVersion
}

// Author returns the application author.
func (s *AppService) Author() string {
	return appAuthor
}
