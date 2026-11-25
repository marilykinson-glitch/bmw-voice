# Trợ lý BMW (`bmw-voice` `v1.1.1`)

Thay thế trình **BMW Intelligent Personal Assistant (IPA)** nguyên bản bằng Tiếng Việt cho đầu **BMW MGU iDrive 7 (`SP18`)**:

- **Gọi rảnh tay `"Hey BMW"` như xe nguyên bản**:
  - **1 bước**: Nói thẳng *"Hey BMW, chỉnh điều hoà 22 độ"* → xe thực thi ngay và hiện giao diện xác nhận chuẩn BMW.
  - **2 bước**: Nói *"Hey BMW"* → màn hình xe tự trượt lên giao diện **BMW Intelligent Personal Assistant** (*"Xin chào, tôi đang lắng nghe…"*) kèm dải đèn nội thất nháy phản hồi để nói câu lệnh tiếp theo.
  - Tiếng nói chuyện phiếm trong khoang lái không có *"Hey BMW"* sẽ tự động được bỏ qua, không bao giờ nhảy thông báo rác.
- **Bấm nút Mic trên vô-lăng hiện ngay giao diện chuẩn BMW**:
  - Bấm nút Mic vô-lăng ở bất kỳ màn hình nào (**kể cả đang mở Apple CarPlay, Bản đồ hay Màn hình chính**): tự động tắt câu báo lỗi của đầu zin, **phủ giao diện trợ lý giọng nói chuẩn BMW đè lên thông báo *"Nhập bằng giọng nói không khả dụng"***, bắt mic tức thì `< 1ms` và tự động đóng lại sau `3.2 giây` khi thực thi xong.
  - Tự động ẩn nhường màn hình ngay lập tức khi gài số lùi (`R` / Camera 360) hoặc có cuộc gọi tới.
  - **Không phát âm thanh TTS ra loa xe**: giữ nguyên 100% nhạc CarPlay / Bluetooth, không bao giờ ngắt hay nhỏ tiếng.

## 6 Nhóm Lệnh Điều Khiển Xe Chuẩn BMW IPA (G30 LCI SP18)

1. **Điều hoà 2 vùng & Kính (`Climate2` / `Climate`)**:
   - *"Hey BMW chỉnh điều hoà 22 độ"*, *"Ghế phụ 24 độ"*, *"Tôi nóng quá"*, *"Tôi lạnh quá"*, *"Mức gió 3"*, *"Bật MAX AC"*, *"Sấy kính trước"*, *"Lấy gió trong"*.
2. **Ghế ngồi & Vô-lăng (`Climate2` / `ComfortFunction2` / `SteeringWheelClimate`)**:
   - *"Bật làm mát ghế tài mức 2"*, *"Sưởi ghế mức 2"*, *"Tắt quạt ghế"*, *"Bật massage ghế"*, *"Sưởi vô-lăng"*.
3. **Đèn viền nội thất chuẩn menu BMW (`ComfortFunctionIuK`)**:
   - *"Hey BMW đổi đèn viền màu cam"*, *"Đèn nội thất màu đồng / trắng / xanh dương / xanh băng / xanh lá / tím"*, *"Độ sáng đèn 80%"*, *"Tắt đèn viền"*.
4. **Âm lượng & Điều khiển nhạc (`CommandControl` / `MediaPlayer`)**:
   - *"Âm lượng 35%"*, *"Tăng âm lượng"*, *"Giảm âm lượng"*, *"Tắt tiếng"*, *"Bài tiếp theo"*, *"Lùi bài"*, *"Tạm dừng nhạc"*, *"Phát tiếp nhạc"*.
5. **Cửa kính & Cửa sổ trời (`WindowLifter` / `SunProtectionRoofWindows`)**:
   - *"Hạ kính ghế tài"*, *"Đóng hết kính"*, *"Hé kính thông gió"*, *"Mở cửa sổ trời"*, *"Đóng rèm trần"*.
6. **Kiểm tra tình trạng xe (`CDS` / `VehicleInformation` / `TPMS`)**:
   - *"Hey BMW kiểm tra tình trạng xe"*, *"Áp suất lốp bao nhiêu"*, *"Nhiệt độ dầu máy"*, *"Còn bao nhiêu xăng"*.

## Cài Đặt Trên MGU Store

1. Thêm nguồn GitHub vào **MGU Store → Settings → Sources**: `marilykinson-glitch/bmw-voice` (nhánh `main`).
2. Cài đặt ứng dụng **Trợ lý BMW** (`bmw_voice` — Store sẽ tự cài dịch vụ nền `bmw-voice` `1.1.1`).
3. Mở **Trợ lý BMW** trên xe lần đầu, quét mã **QR** bằng điện thoại để dán **Gemini API Key** và bấm **Lưu cấu hình**.
4. Từ lúc đó trở đi, không cần mở lại app nữa — đang chạy CarPlay hay ở bất kỳ đâu chỉ cần nói **"Hey BMW"** hoặc **bấm nút Mic trên vô-lăng** là dùng như nguyên bản!
