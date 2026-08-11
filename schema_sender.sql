-- 批㉘：emails 记录实际发件人（发件域切换 wanew.net 的地基）。
-- 存量回填 hello@tejoy.net：历史信全部由它发出（事实），followup 沿发信史的路由才有据可依。
ALTER TABLE emails ADD COLUMN sender_email TEXT;
UPDATE emails SET sender_email = 'hello@tejoy.net' WHERE sender_email IS NULL;
