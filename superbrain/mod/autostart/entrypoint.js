/**
 * Superbrain 测试夹具：覆盖 public 的 autostart/entrypoint.js。
 *
 * 原版把 Engine.SwitchGuiPage mock 成空函数，所以 -autostart 只跑仿真、
 * 永远进不了 page_loading → page_session，GUI 作用域的桥接内核根本不加载。
 * 这里只去掉那一个 mock（其余 mock 保持原样），命令行就能拉起一个
 * 带完整 session GUI 的对局 —— 实战副驾的回归测试和 M4 批量自学习都靠它。
 *
 * 只在带 -autostart 启动时被加载，不影响正常从菜单开局。
 */

Engine.HasXmppClient = () => false;
Engine.SetRankedGame = () => {};
Engine.TextureExists = () => false;
Engine.OpenChildPage = () => {};

/**
 * 无头模式（-autostart-nonvisual）没有 GUI 页面子系统，
 * 那里切页会直接炸掉，所以只有可视路径才恢复真实的 SwitchGuiPage。
 */
function superbrainNonVisual()
{
	for (const key of ["autostart-nonvisual", "nonvisual"])
	{
		try
		{
			if (Engine.GetEngineConfig(key) === "true")
				return true;
		}
		catch (e)
		{
			// 这个引擎没暴露该配置项，继续试下一个
		}
	}
	return false;
}

if (superbrainNonVisual())
	Engine.SwitchGuiPage = () => {};

var translateObjectKeys = () => {};
var translate = x => x;
var translateWithContext = x => x;

// Required for functions such as sprintf.
Engine.LoadScript("globalscripts/");
// MsgBox is used in the failure path.
Engine.LoadScript("gui/common/functions_msgbox.js");

var autostartInstance;

function autostartClient(cmdLineArgs)
{
	autostartInstance = new AutoStartClient(cmdLineArgs);
}

function autostartHost(cmdLineArgs, networked = false)
{
	Engine.LoadScript("gui/common/color.js");
	Engine.LoadScript("gui/common/functions_utility.js");
	Engine.LoadScript("gui/common/Observable.js");
	Engine.LoadScript("gui/common/settings.js");

	Engine.LoadScript("gui/maps/MapCache.js");

	Engine.LoadScript("gamesettings/");
	Engine.LoadScript("gamesettings/attributes/");

	if (networked)
		autostartInstance = new AutoStartHost(cmdLineArgs);
	else
		autostartInstance = new AutoStart(cmdLineArgs);
}

/**
 * @returns false if the loop should carry on.
 */
function onTick()
{
	return autostartInstance.onTick();
}
