import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
// 代码高亮主题在 public/style.css 中以 token 形式按亮/暗主题定义

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
