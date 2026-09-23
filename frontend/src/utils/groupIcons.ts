// 仓库分组可选图标（来自 @lucide/vue）。key 会被持久化到后端配置，
// 因此 key 一旦发布就不要再改名（改名会导致已保存的分组图标回退成默认）。
import type { Component } from "vue";
import {
	Archive,
	Bell,
	Bookmark,
	Box,
	Briefcase,
	Bug,
	Camera,
	Cloud,
	Code,
	Coffee,
	Compass,
	Cpu,
	Crown,
	Database,
	Flag,
	Flame,
	Folder,
	FolderGit2,
	FolderOpen,
	Gamepad2,
	Gem,
	Globe,
	GraduationCap,
	Hammer,
	Heart,
	Key,
	Layers,
	Leaf,
	Lightbulb,
	Lock,
	MapPin,
	Moon,
	Music,
	Package,
	Palette,
	Plane,
	Puzzle,
	Rocket,
	Server,
	ShoppingCart,
	Shield,
	Sparkles,
	Star,
	Sun,
	Target,
	Terminal,
	TreePine,
	Trophy,
	Users,
	Wrench,
	Zap,
} from "@lucide/vue";

export interface GroupIconDef {
	key: string;
	label: string;
	comp: Component;
}

/** 默认图标 key（未设置图标时使用） */
export const DEFAULT_GROUP_ICON = "folder";

export const GROUP_ICONS: GroupIconDef[] = [
	{ key: "folder", label: "文件夹", comp: Folder },
	{ key: "folder-open", label: "打开文件夹", comp: FolderOpen },
	{ key: "folder-git", label: "Git 仓库", comp: FolderGit2 },
	{ key: "star", label: "星标", comp: Star },
	{ key: "heart", label: "收藏", comp: Heart },
	{ key: "bookmark", label: "书签", comp: Bookmark },
	{ key: "flag", label: "旗帜", comp: Flag },
	{ key: "zap", label: "闪电", comp: Zap },
	{ key: "rocket", label: "火箭", comp: Rocket },
	{ key: "flame", label: "火焰", comp: Flame },
	{ key: "sparkles", label: "闪耀", comp: Sparkles },
	{ key: "target", label: "目标", comp: Target },
	{ key: "trophy", label: "奖杯", comp: Trophy },
	{ key: "globe", label: "全球", comp: Globe },
	{ key: "server", label: "服务器", comp: Server },
	{ key: "database", label: "数据库", comp: Database },
	{ key: "cloud", label: "云端", comp: Cloud },
	{ key: "terminal", label: "终端", comp: Terminal },
	{ key: "code", label: "代码", comp: Code },
	{ key: "bug", label: "缺陷", comp: Bug },
	{ key: "cpu", label: "芯片", comp: Cpu },
	{ key: "palette", label: "调色板", comp: Palette },
	{ key: "box", label: "盒子", comp: Box },
	{ key: "package", label: "包", comp: Package },
	{ key: "layers", label: "分层", comp: Layers },
	{ key: "archive", label: "归档", comp: Archive },
	{ key: "briefcase", label: "公文包", comp: Briefcase },
	{ key: "hammer", label: "工具", comp: Hammer },
	{ key: "wrench", label: "扳手", comp: Wrench },
	{ key: "key", label: "密钥", comp: Key },
	{ key: "lock", label: "锁", comp: Lock },
	{ key: "shield", label: "盾牌", comp: Shield },
	{ key: "graduation-cap", label: "学习", comp: GraduationCap },
	{ key: "lightbulb", label: "灵感", comp: Lightbulb },
	{ key: "puzzle", label: "拼图", comp: Puzzle },
	{ key: "gem", label: "宝石", comp: Gem },
	{ key: "bell", label: "提醒", comp: Bell },
	{ key: "crown", label: "皇冠", comp: Crown },
	{ key: "users", label: "团队", comp: Users },
	{ key: "cart", label: "购物车", comp: ShoppingCart },
	{ key: "map-pin", label: "地点", comp: MapPin },
	{ key: "compass", label: "指南针", comp: Compass },
	{ key: "plane", label: "飞机", comp: Plane },
	{ key: "music", label: "音乐", comp: Music },
	{ key: "camera", label: "相机", comp: Camera },
	{ key: "coffee", label: "咖啡", comp: Coffee },
	{ key: "gamepad", label: "游戏", comp: Gamepad2 },
	{ key: "leaf", label: "叶子", comp: Leaf },
	{ key: "tree", label: "树", comp: TreePine },
	{ key: "sun", label: "太阳", comp: Sun },
	{ key: "moon", label: "月亮", comp: Moon },
];

const ICON_MAP = new Map<string, Component>(
	GROUP_ICONS.map((d) => [d.key, d.comp]),
);

/** 解析图标 key 对应的组件；未注册（含空串）时回退到默认图标。 */
export function groupIconComponent(key?: string): Component {
	return (key && ICON_MAP.get(key)) || Folder;
}

/** 图标 / 文字颜色预设。color === "" 表示跟随主题（默认色）。 */
export interface GroupColorDef {
	label: string;
	color: string;
}

export const GROUP_COLORS: GroupColorDef[] = [
	{ label: "默认", color: "" },
	{ label: "红", color: "#e06c75" },
	{ label: "橙", color: "#d19a66" },
	{ label: "琥珀", color: "#e5c07b" },
	{ label: "绿", color: "#98c379" },
	{ label: "青", color: "#56b6c2" },
	{ label: "蓝", color: "#61afef" },
	{ label: "靛", color: "#7c6cf0" },
	{ label: "紫", color: "#c678dd" },
	{ label: "粉", color: "#f778ba" },
	{ label: "灰", color: "#8b949e" },
];
