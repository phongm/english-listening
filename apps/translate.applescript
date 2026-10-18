-- 译剪贴板：在任意 App 里选中英文 → ⌘C → 双击本图标（或快捷键）
-- 译文会弹窗显示，点「复制译文」才覆盖剪贴板，避免弄丢原文。
try
	set out to do shell script "/bin/bash ~/English/run.sh tr-clipboard"
	if (count of out) is 0 then error "没拿到译文"
	set btn to button returned of (display dialog out with title "译文" buttons {"关闭", "复制译文"} default button 2 with icon note)
	if btn is "复制译文" then
		set the clipboard to out
		display notification "译文已在剪贴板" with title "复制完成"
	end if
on error errMsg number errNum
	if errNum is not -128 then
		display alert "翻译失败" message (errMsg as string) & "
（先确认 install.command 跑过且网络/代理可用）"
	end if
end try
