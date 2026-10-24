import type { GalleryConfig } from "@/types/galleryConfig";

// 相册配置
export const galleryConfig: GalleryConfig = {
	// 相册列表
	// 每添加一个数组项就相当于添加了一个相册，记得在 public/gallery/ 目录下创建对应的子目录并放入图片
	albums: [
		{
			id: "records",
			name: "记录",
			// 列表页缩略图用这张（209 KB）；不指定则自动取第一张（01.webp 1823 KB，偏重）
			cover: "/gallery/records/13.jpg",
		},
	],

	// 瀑布流最小列宽(px)，浏览器根据容器宽度自动计算列数，默认 240
	// 值越小列数越多，值越大列数越少
	columnWidth: 240,
};
