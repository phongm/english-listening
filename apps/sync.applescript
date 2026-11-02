-- 每日英语听力·同步：带调试端口启动 App + 字幕服务 + 置顶字幕条
-- 双击后如果 App 已经在运行，会先问是否重启一次（进度会自动恢复）。
on run
	try
		set state to do shell script "/bin/bash ~/English/run.sh ting-sync-state"
		if state is "running-no-debug" then
			activate
			set answer to display dialog "需要重启一次「每日英语听力」，才能开启译文同步。" & return & return & "重启会中断当前播放，播放进度会自动恢复。继续吗？" buttons {"取消", "重启并开启"} default button 2 with title "译文同步" with icon note
			if button returned of answer is "重启并开启" then
				do shell script "/bin/bash ~/English/run.sh ting-sync-launch"
			else
				return
			end if
		else
			do shell script "/bin/bash ~/English/run.sh ting-sync-start"
		end if
		display notification "字幕条已就绪；在 App 里播放即可" with title "译文同步"
	on error errMsg number errNum
		if errNum is not -128 then
			display alert "启动同步失败" message (errMsg as string) & "
（先双击 install.command 完成安装；细节见 ~/English/logs/ting-sync.log）"
		end if
	end try
end run
