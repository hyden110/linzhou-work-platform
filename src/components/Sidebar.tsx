import {
  Blocks,
  BookOpenText,
  Bot,
  CalendarDays,
  Cloud,
  Cpu,
  Database,
  Gauge,
  Inbox,
  LayoutDashboard,
  Megaphone,
  MessagesSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  RefreshCw,
  Settings,
  Shapes,
  Sparkles,
  Target,
  UserRound,
  Users,
  Workflow,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ViewId } from "../types";

interface NavigationItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
}

interface NavigationGroup {
  eyebrow: string;
  items: NavigationItem[];
}

const navigation: NavigationGroup[] = [
  {
    eyebrow: "CUSTOMER OPS",
    items: [
      { id: "cockpit", label: "驾驶舱", icon: Gauge },
      { id: "customers", label: "客户盘面", icon: Users },
      { id: "dingtalk", label: "钉群盘面", icon: MessagesSquare },
      { id: "lifecycle", label: "PPL 跟进", icon: Workflow },
      { id: "okr", label: "OKR 目标", icon: Target },
      { id: "leads", label: "拓新雷达", icon: Radar },
      { id: "report", label: "日周报", icon: CalendarDays },
      { id: "inbox", label: "消息中心", icon: Inbox },
    ],
  },
  {
    eyebrow: "KNOWLEDGE",
    items: [
      { id: "overview", label: "总览", icon: LayoutDashboard },
      { id: "ask", label: "AI 问答", icon: Bot },
      { id: "map", label: "知识地图", icon: Network },
      { id: "assistant", label: "方案助手", icon: Sparkles },
      { id: "documents", label: "全部资料", icon: BookOpenText },
      { id: "ontology", label: "本体管理", icon: Shapes },
      { id: "yunqi", label: "云栖大会", icon: Cloud },
      { id: "sync", label: "同步中心", icon: RefreshCw },
    ],
  },
  {
    eyebrow: "GROWTH OPS",
    items: [
      { id: "ops", label: "运营推广", icon: Megaphone },
    ],
  },
  {
    eyebrow: "AGENT OPS",
    items: [
      { id: "agents", label: "数字员工", icon: Cpu },
      { id: "profile", label: "个人中心", icon: UserRound },
      { id: "datasources", label: "数据源管理", icon: Database },
      { id: "settings", label: "设置", icon: Settings },
    ],
  },
];

interface SidebarProps {
  activeView: ViewId;
  collapsed: boolean;
  mobileOpen: boolean;
  onNavigate: (view: ViewId) => void;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
}

export function Sidebar({
  activeView,
  collapsed,
  mobileOpen,
  onNavigate,
  onToggleCollapsed,
  onCloseMobile,
}: SidebarProps) {
  const selectView = (view: ViewId) => {
    onNavigate(view);
    onCloseMobile();
  };

  return (
    <aside className={`sidebar ${collapsed ? "sidebar--collapsed" : ""} ${mobileOpen ? "sidebar--open" : ""}`}>
      <div className="brand">
        <div className="brand__mark"><Blocks size={19} strokeWidth={1.8} /></div>
        <div className="brand__copy">
          <strong>SA</strong>
          <span>Knowledge Ops</span>
        </div>
        <button className="icon-button sidebar__mobile-close" onClick={onCloseMobile} aria-label="关闭导航">
          <X size={18} />
        </button>
      </div>

      <div className="sidebar__context" title="本地索引正常">
        <Database size={15} />
        <span>个人知识域</span>
        <i aria-hidden="true" />
      </div>

      <nav className="navigation" aria-label="主导航">
        {navigation.map((group) => (
          <div key={group.eyebrow} className="navigation__group">
            <span className="navigation__eyebrow">{group.eyebrow}</span>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={`navigation__item ${activeView === item.id ? "is-active" : ""}`}
                  onClick={() => selectView(item.id)}
                  title={collapsed ? item.label : undefined}
                  aria-current={activeView === item.id ? "page" : undefined}
                >
                  <Icon size={18} strokeWidth={1.8} />
                  <span>{item.label}</span>
                  {activeView === item.id && <b />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar__footer">
        <div className="storage-ring" role="img" aria-label="本地元数据索引">
          <span>LOCAL</span>
        </div>
        <div className="sidebar__footer-copy">
          <strong>仅元数据索引</strong>
          <span>原始资料不离开本机</span>
        </div>
      </div>
      <button className="sidebar__collapse" onClick={onToggleCollapsed} aria-label={collapsed ? "展开导航" : "收起导航"}>
        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </button>
    </aside>
  );
}
