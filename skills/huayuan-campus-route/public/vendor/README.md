# Vendor assets

- `leaflet.js` / `leaflet.css`: Leaflet 1.9.4, BSD-2-Clause, https://leafletjs.com/
- 地图瓦片由页面直接向高德地图请求（标准地图），版权归高德地图所有；页面底部保留“底图 © 高德地图”标注。
- 步行道路线优先请求 `routing.openstreetmap.de/routed-foot`（OSM foot routing），版权归 OpenStreetMap contributors（ODbL）；只发送起终点坐标，不带身份信息。失败或离线时回退校园步行图直线。
- 坐标系统一为 GCJ-02；底图与校园点位使用同一套坐标，避免偏移。
