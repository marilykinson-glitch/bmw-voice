# Trợ lý BMW (`bmw-voice`) — BMW MGU iDrive 7

Trợ lý giọng nói Tiếng Việt tối giản theo đúng hướng **BMW Intelligent Personal Assistant (IPA)** nguyên bản cho xe BMW iDrive 7 (`MGU SP18`):

- **Kích hoạt đúng chuẩn zin BMW**: Bấm nút **Mic trên vô-lăng** (tự tắt thông báo *"không hỗ trợ ngôn ngữ"* của đầu zin) hoặc chạm vòng tròn trên màn hình `Trợ lý BMW` -> nói câu lệnh Tiếng Việt -> tự ngắt ngay sau `0.5s` khi dứt lời -> thực thi tức thì và hiện xác nhận ngay trên màn hình.
- **Tuyệt đối không ngắt hay hạ nhỏ nhạc CarPlay / Bluetooth** (không tải file âm thanh TTS, không chiếm luồng ALSA nền).
- **An toàn tuyệt đối cho đầu MGU**: Khởi động sau `oapcontroller.service`, `LimitCORE=1`, `0%` CPU khi chờ, không mở thiết bị phần cứng `avb:`/`hw:`.

## 6 Nhóm lệnh nguyên bản BMW hỗ trợ
1. **Điều hoà 2 vùng & Sấy kính**: *"Điều hoà 22 độ"*, *"Tôi nóng quá"*, *"Tôi lạnh quá"*, *"Max AC"*, *"Mức gió 3"*, *"Bật sấy kính"*, *"Lấy gió trong"*, *"Đồng bộ điều hoà"*.
2. **Ghế & Vô-lăng**: *"Làm mát ghế mức 2"*, *"Bật sưởi ghế"*, *"Bật massage ghế"*, *"Bật sưởi vô-lăng"*.
3. **Đèn viền nội thất BMW**: *"Đèn viền màu cam"*, *"Đèn viền màu đồng / trắng / xanh dương / xanh băng / xanh lá / tím"*, *"Độ sáng đèn 85%"*, *"Tắt đèn viền"*.
4. **Âm lượng & Nhạc**: *"Âm lượng 35%"*, *"Tăng âm lượng"*, *"Nhỏ tiếng lại"*, *"Tắt tiếng"*, *"Bài tiếp theo"*, *"Bài trước"*, *"Tạm dừng nhạc"*.
5. **Cửa kính & Cửa sổ trời**: *"Hạ kính tài"*, *"Đóng hết kính"*, *"Hé kính"*, *"Mở / Đóng cửa sổ trời"*.
6. **Tình trạng xe**: *"Tình trạng xe"*, *"Nhiệt độ dầu máy"*, *"Áp suất lốp"*, *"Còn bao nhiêu xăng"*.
