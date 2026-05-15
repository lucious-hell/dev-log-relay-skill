class FakeElement {
  constructor(text) {
    this.textValue = text;
  }

  async text() {
    return this.textValue;
  }

  async attribute(name) {
    if (name === "aria-label") return this.textValue;
    return "";
  }

  async tap() {
    return true;
  }

  async input() {
    return true;
  }
}

class FakePage {
  constructor(route) {
    this.route = route;
  }

  async $$(selector) {
    if (process.env.DEV_LOG_RELAY_FAKE_MINIAPP_VISIBLE_TEXT === "none") return [];
    if (selector === "button") return [new FakeElement("确认")];
    if (selector === "text" || selector === "view") return [new FakeElement("首页 Ready 列表")];
    return [];
  }

  async $(selector) {
    return new FakeElement(selector || "目标控件");
  }

  async screenshot() {
    return Buffer.from("fake-screenshot");
  }
}

class FakeMiniProgram {
  constructor() {
    this.route = "/pages/home/index";
  }

  async reLaunch(options) {
    this.route = options?.url || this.route;
  }

  async navigateTo(options) {
    this.route = options?.url || this.route;
  }

  async switchTab(options) {
    this.route = options?.url || this.route;
  }

  async navigateBack() {
    this.route = "/pages/home/index";
  }

  async currentPage() {
    return new FakePage(this.route);
  }

  async disconnect() {
    return true;
  }
}

export async function connect() {
  return new FakeMiniProgram();
}

export async function launch() {
  return new FakeMiniProgram();
}
