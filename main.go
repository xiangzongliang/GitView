package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	updateService := NewUpdateService()
	// RepoService 同时供 AI 服务读取 config.json 中的模型配置。
	repoService := &RepoService{}

	app := application.New(application.Options{
		Name:        "Git View",
		Description: "Git View - a modern Git desktop client built with Wails v3",
		Services: []application.Service{
			application.NewService(&GitService{}),
			application.NewService(repoService),
			application.NewService(&AppService{}),
			application.NewService(updateService),
			application.NewService(NewAiService(repoService)),
		},
		Assets: application.AssetOptions{
			// 复合处理器：/gitview-file 直接返回仓库图片字节（见 repoimage.go），
			// 其余请求交给默认的静态资源服务（生产=内嵌 dist，开发=代理到 vite）。
			Handler: newRepoFileHandler(application.AssetFileServerFS(assets), repoService),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Git View",
		Width:  1400,
		Height: 920,
		Mac: application.MacWindow{
			// 顶部 24pt 为原生窗口拖拽区（该区域内不放交互控件）
			InvisibleTitleBarHeight: 24,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
			CornerType:              application.MacWindowCornerTypeRounded,
			CornerRadius:            16,
		},
		BackgroundType: application.BackgroundTypeTranslucent,
		Windows:        application.WindowsWindow{},
		URL:            "/",
	})

	// 初始化自更新能力（app 创建后 app.Updater 才可用）。
	// 失败只记录日志，不阻塞启动，也不影响应用使用。
	if err := updateService.configure(app.Updater); err != nil {
		log.Printf("[updater] 初始化失败：%v", err)
	}

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
