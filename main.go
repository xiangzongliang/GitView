package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := application.New(application.Options{
		Name:        "Git View",
		Description: "Git View - a SourceTree-like Git GUI built with Wails v3",
		Services: []application.Service{
			application.NewService(&GitService{}),
			application.NewService(&RepoService{}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Git View",
		Width:  1400,
		Height: 900,
		Mac: application.MacWindow{
			// 顶部 50pt 为原生窗口拖拽区（该区域内不放交互控件）
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
			CornerType:              application.MacWindowCornerTypeRounded,
			CornerRadius:            16,
		},
		BackgroundType: application.BackgroundTypeTranslucent,
		Windows:        application.WindowsWindow{},
		URL:            "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
