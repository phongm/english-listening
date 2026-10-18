-- 抓课文：复制一条 VOA Learning English 课文链接 → 双击本图标
-- 结果：~/English/voa/<编号>.txt + 音频 + <编号>.对照.md，并自动打开对照表。
try
	set out to do shell script "/bin/bash ~/English/run.sh grab-clipboard"
	display notification out with title "双语对照已生成"
on error errMsg number errNum
	if errNum is not -128 then
		display alert "抓课文失败" message (errMsg as string) & "
（请确认剪贴板里是 https://learningenglish.voanews.com/a/... 的课文页）"
	end if
end try
