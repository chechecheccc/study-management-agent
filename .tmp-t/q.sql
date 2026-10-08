SELECT t.title, t.type, t.status, t.priority, t.due_at, t.reminder,
       CASE WHEN t.due_at < to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI') THEN '已过期'
            ELSE '未到期' END AS 实际时间状态
FROM tasks t JOIN users u ON u.id = t.user_id
WHERE u.username = 'admin' ORDER BY t.due_at;
