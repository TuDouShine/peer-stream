/* ============================================================================
   Peer-Stream 控制台 — 界面逻辑
   作为传统脚本加载（非 module），以便 HTML 内联事件处理器可调用这些全局函数。
   ========================================================================== */

// DOM查询缓存
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// ─── 主题切换 ───────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("ps-theme", theme);
  const btn = $("#themeToggle");
  if (btn) {
    btn.setAttribute("icon", theme === "dark" ? "🌙" : "☀️");
    btn.setAttribute("title", theme === "dark" ? "深色" : "浅色");
  }
}
function toggleTheme() {
  applyTheme(document.body.getAttribute("data-theme") === "dark" ? "light" : "dark");
}
applyTheme(localStorage.getItem("ps-theme") || "dark");

// ─── Toast 通知 ──────────────────────────────────────────────────────────────
function toast(message, type = "info", timeout = 3200) {
  let box = $("#toast-container");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast-container";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

//更新成功提示
const handleUpdateSuccess = (btn) => {
  if (btn) {
    let normal = btn.getAttribute("title");
    let mini = btn.getAttribute("icon");
    btn.setAttribute("title", "更新成功");
    btn.setAttribute("icon", "✅");
    btn.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 200,
      iterations: 3,
      easing: "steps(2, jump-none)",
    });
    setTimeout(() => {
      btn.setAttribute("title", normal);
      btn.setAttribute("icon", mini);
    }, 1000);
  }
  toast("保存成功", "ok");
};

async function handleCheckUpdate() {
  const writeFiles = (SignalHtmlContent, SignalJSContent, PeerStreamContent) => {
    const contents = [
      { content: SignalHtmlContent, path: "/signal.html" },
      { content: SignalJSContent, path: "/signal.js" },
      { content: PeerStreamContent, path: "/peer-stream.js" },
    ];
    let fetchPromises = [];

    contents.forEach(({ content, path }) => {
      if (content) {
        fetchPromises.push(
          fetch("./write", {
            method: "POST",
            headers: {
              write: path,
            },
            body: content,
          })
        );
      }
    });

    if (fetchPromises.length > 0) {
      Promise.all(fetchPromises)
        .then((responses) =>
          Promise.all(
            responses.map((response) => {
              if (!response.ok) {
                throw response.headers.get("error");
              }
              handleUpdateSuccess($("#checkUpdate"));
            })
          )
        )
        .catch((error) => {
          toast(`更新失败: ${error}`, "err");
          console.error("Update error:", error);
        });
    } else {
      console.log("No file to upload.");
    }
  };

  let SignalHtmlContent,
    SignalJSContent,
    PeerStreamContent = "";

  const checkUpdate = $("#checkUpdate");
  checkUpdate.setAttribute("title", "更新中...");
  checkUpdate.setAttribute("icon", "⏳");
  // 先通过github仓库尝试获取，如果失败，允许用户本地上传
  Promise.all([
    fetch("https://inveta.github.io/peer-stream/signal.html"),
    fetch("https://inveta.github.io/peer-stream/signal.js"),
    fetch("https://inveta.github.io/peer-stream/peer-stream.js"),
  ])
    .then((responses) =>
      Promise.all(
        responses.map((response) => {
          if (!response.ok) throw new Error(`Network response for ${response.url} was not ok`);
          return response.text();
        })
      )
    )
    .then((files) => {
      writeFiles(...files);
    })
    .catch((error) => {
      let inputElement = document.createElement("input");
      inputElement.type = "file";
      inputElement.multiple = true;
      inputElement.style.display = "none";

      const readFile = (file) => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = (e) => reject(e);
          reader.readAsText(file);
        });
      };

      inputElement.addEventListener("change", (event) => {
        const files = event.target.files;
        const fileList = {
          "signal.html:text/html": (content) => (SignalHtmlContent = content),
          "signal.js:text/javascript": (content) => (SignalJSContent = content),
          "peer-stream.js:text/javascript": (content) => (PeerStreamContent = content),
        };

        if (files.length > 3) {
          checkUpdate.setAttribute("title", "检查更新");
          checkUpdate.setAttribute("icon", "🔍");
          toast("选择文件数量应小于等于3个！", "err");
          return;
        }

        let readPromises = [];

        Array.from(files).forEach((file) => {
          const fileKey = `${file.name}:${file.type}`;
          fileList[fileKey]
            ? readPromises.push(readFile(file).then(fileList[fileKey]))
            : toast("请上传 signal.html、signal.js 或 peer-stream.js 文件", "err");
        });
        Promise.all(readPromises)
          .then(() => {
            writeFiles(SignalHtmlContent, SignalJSContent, PeerStreamContent);
          })
          .catch((e) => {
            console.error("Error reading file:", e);
          });
      });
      inputElement.click();
    });
}

//读取signal.json中的参数，对参数配置表单进行初始化渲染
const renderConfigForm = () => {
  const execTemp = `
    <inline class="exec">
      <label for="GPU_graphicsAdapter">GPU graphicsAdapter 承载量</label>
      <input name="processNumber" id="GPU_graphicsAdapter" type="number" value="GPUNumber" placeholder="请输入需要的进程个数"/>
    </inline>
  `;

  const updateUE5Info = (value) => {
    const parseUE5 = (UE5) => {
      const toCamelCase = (str) => str.charAt(1).toLowerCase() + str.slice(2);
      const params = UE5.split(" ");
      const exec = {
        unattended: false,
        renderOffScreen: false,
        audioMixer: false,
        GPUFile: params[1],
      };
      let boolParams = ["-Unattended", "-RenderOffScreen", "-AudioMixer"];

      for (const param of params) {
        if (param.startsWith("-")) {
          const [key, value] = param.split("=");
          exec[toCamelCase(key)] = boolParams.includes(key) ? true : value;
        }
      }
      const { resX, resY, ...rest } = exec;
      return { ...rest, resolution: `${resX}*${resY}` };
    };

    if (value.length <= 0) {
      $(`[name = GPUNumber]`).value = 0;
      return;
    }
    const shareInfo = parseUE5(value[0]);
    shareInfo.graphicsAdapter = new Map();
    value.forEach((exec) => {
      const { graphicsAdapter } = parseUE5(exec);
      shareInfo.graphicsAdapter.set(
        graphicsAdapter,
        (shareInfo.graphicsAdapter.get(graphicsAdapter) || 0) + 1
      );
    });
    shareInfo.GPUNumber = shareInfo.graphicsAdapter.size;
    for (const item in shareInfo) {
      if (item === "graphicsAdapter") {
        $$(".exec").forEach((exec) => exec.remove());
        for (const gpuInfo of shareInfo.graphicsAdapter) {
          let exec = new DOMParser()
            .parseFromString(
              execTemp.replaceAll("graphicsAdapter", gpuInfo[0]).replaceAll("GPUNumber", gpuInfo[1]),
              "text/html"
            )
            .querySelector(".exec");
          $("#GPU").after(exec);
        }
      } else {
        const input = $(`[name="${item}"]`);
        if (input) {
          if (input.type === "checkbox") input.checked = shareInfo[`${item}`];
          else input.value = shareInfo[`${item}`];
        }
      }
    }
  };

  return fetch("./signal.json")
    .then((res) => {
      if (!res.ok) throw res.status;
      return res.json();
    })
    .then((data) => {
      const handlers = {
        UE5: (value) => updateUE5Info(value),
        iceServers: (value) => ($("[name=iceServers]").value = JSON.stringify(value, null, "\t")),
        auth: (value) => {
          if (value) {
            $("#auth").value = value;
            $("#http-auth").checked = true;
          } else {
            $("#http-auth").checked = false;
          }
        },
        UEVersion: (value) => ($("[name=UEVersion]").checked = value === 4.27),
      };

      Object.keys(data).forEach((key) => {
        if (handlers[key]) {
          handlers[key](data[key]);
        } else {
          const input = $(`[name="${key}"]`);
          if (input) {
            if (input.type === "checkbox") input.checked = data[key];
            else input.value = data[key];
          }
        }
      });
    })
    .catch((error) => {
      toast(`读取配置失败: ${error}`, "err");
    });
};

//上传处理后的signal参数
const handleConfigUpdate = async (config, PORT_new) => {
  return fetch("./signal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      signal: encodeURIComponent(JSON.stringify(config)),
    },
  })
    .then((response) => {
      if (!response.ok) throw response.headers.get("error");
      handleUpdateSuccess($(`:target`));
      if (PORT_new) location.port = PORT_new;
    })
    .catch((error) => {
      toast(`保存失败: ${error}`, "err");
      renderConfigForm();
      console.error(error);
    });
};

//对需要上传的signal参数进行处理并准备上传
const submitConfig = async (event) => {
  const execTemp = `
    <inline class="exec">
      <label for="GPU_graphicsAdapter">GPU graphicsAdapter 承载量</label>
      <input name="processNumber" id="GPU_graphicsAdapter" type="number" value="GPUNumber" placeholder="请输入需要的进程个数"/>
    </inline>
  `;

  const createUE5Config = () => {
    const getValue = (name) => $(`[name=${name}]`).value;
    const isChecked = (name) => $(`[name=${name}]`).checked;

    const startCmds = { exe: "start", sh: "sh" };

    const filePath = getValue("GPUFile");
    const startCmd = startCmds[filePath.slice(((filePath.lastIndexOf(".") - 1) >>> 0) + 2)];
    let config = [];
    let [resX, resY] = getValue("resolution").split("*");
    let pixelStreamingURL = window.location.host;

    $$("[name=processNumber]").forEach((processNumber) => {
      for (let i = 0; i < processNumber.value; i++) {
        config.push(
          `${startCmd} ${filePath} ${isChecked("unattended") ? "-Unattended " : ""}` +
            `${isChecked("renderOffScreen") ? "-RenderOffScreen " : ""}${
              isChecked("audioMixer") ? "-AudioMixer " : ""
            }` +
            `-PixelStreamingURL=ws://${pixelStreamingURL}/ -GraphicsAdapter=${processNumber.id.slice(
              4
            )} -ForceRes ` +
            `-ResX=${resX} -ResY=${resY} -PixelStreamingWebRTCFps=${getValue(
              "pixelStreamingWebRTCFps"
            )}`
        );
      }
    });
    return config;
  };

  const appendExecElements = (gpuNumber, execElements) => {
    for (let i = execElements.length; i < gpuNumber; i++) {
      let exec = new DOMParser()
        .parseFromString(
          execTemp.replaceAll("graphicsAdapter", i).replaceAll("GPUNumber", 0),
          "text/html"
        )
        .querySelector(".exec");
      $("#GPU").after(exec);
    }
  };
  const removeExecElements = (gpuNumber, execElements) => {
    const excessElements = Array.from(execElements).slice(gpuNumber);
    let needToupdate = true;
    excessElements.forEach((exec) => {
      if (exec.querySelector(`[name = processNumber]`).value > 0) needToupdate = false;
      exec.remove();
    });
    return needToupdate;
  };

  const handlers = {
    GPUNumber: (value) => {
      const gpuNumber = parseInt(value, 10);
      if (gpuNumber < 0) {
        toast("GPU 数量不能小于0", "err");
        renderConfigForm();
        return true;
      }
      const execElements = $$(".exec");
      let needsUpdate = true;
      execElements.length < gpuNumber
        ? appendExecElements(gpuNumber, execElements)
        : (needsUpdate = removeExecElements(gpuNumber, execElements));
      return needsUpdate;
    },
    "http-auth": (value) => value,
    auth: (value) => {
      if (!/^[a-zA-Z0-9]+:[a-zA-Z0-9]+$/.test(value)) {
        toast("请输入正确的用户名和密码格式，例如：username:password", "err");
        return true;
      }
      return false;
    },
    iceServers: (value) => {
      try {
        JSON.parse(value);
        return false;
      } catch (error) {
        toast("iceServers 格式有误！", "err");
        renderConfigForm();
        return true;
      }
    },
  };

  let config = {};
  let value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  let PORT_new = null;

  if (handlers[event.target.id] && handlers[event.target.id](value)) return;
  if (
    [
      "GPUFile",
      "resolution",
      "pixelStreamingWebRTCFps",
      "GPUNumber",
      "unattended",
      "renderOffScreen",
      "audioMixer",
    ].includes(event.target.id) ||
    event.target.id.includes("GPU_")
  ) {
    config["UE5"] = createUE5Config();
  } else {
    switch (event.target.type) {
      case "number":
        config[event.target.id] = parseFloat(value);
        if (event.target.id === "PORT" && value !== window.location.port) PORT_new = value;
        break;
      case "checkbox":
        config[event.target.id === "http-auth" ? "auth" : event.target.id] =
          event.target.id === "UEVersion" ? (value ? 4.27 : 5) : value;
        break;
      default:
        config[event.target.id] = event.target.name === "iceServers" ? JSON.parse(value) : value;
    }
  }

  await handleConfigUpdate(config, PORT_new);
};

const getProcess = () => {
  let ws = `ws://${location.host}/${navigator.platform}/admin`;
  ws = new WebSocket(ws, `exec-ue`);
  ws.onopen = function () {
    console.info("✅", ws);
    window.addEventListener("hashchange", () => ws.close(), { once: true });
  };

  ws.onmessage = function (e) {
    let logs = JSON.parse(e.data);
    logs = logs
      .map(
        (a) => `
          <tr ${a.type}>
            <td>${a.type}</td>
            <td>${a.address}</td>
            <td>${a.PORT}</td>
            <td>${a.path}</td>
            <td>断开</td>
          </tr>`
      )
      .join("");
    $("table tbody").innerHTML = logs;
  };

  ws.onclose = (e) => {
    console.log(e);
  };
};

async function tableClick(event) {
  if (event.target.innerHTML === "断开") {
    const process = event.target.parentElement.children;
    const PORT = process[2].innerText;
    let evalMap = {
      "signal.js": "setTimeout(()=>process.exit(0),1),''",
      "Unreal Engine": `killUE(${PORT})`,
      "peer-stream": `killPlayer(${PORT})`,
      "exec-ue": "throw '这是管理员'",
    };

    const evalCode = encodeURIComponent(evalMap[process[0].innerText]);

    await fetch("./eval", {
      method: "POST",
      headers: { eval: evalCode },
    })
      .then((r) => {
        if (!r.ok) throw decodeURIComponent(r.headers.get("error"));
        toast("操作成功", "ok");
      })
      .catch((error) => toast(error, "err"));
  }
}

async function getStats() {
  if (ps.pc.connectionState !== "connected") return;

  let cue = ` Current Time: ${ps.currentTime} s`;

  if (ps.VideoEncoderQP < 27) {
    document.documentElement.style.setProperty("--cue", "lime");
  } else if (ps.VideoEncoderQP < 36) {
    document.documentElement.style.setProperty("--cue", "orange");
    cue += `\n Spotty Network !`;
  } else {
    document.documentElement.style.setProperty("--cue", "red");
    cue += `\n Bad Network !!`;
  }

  cue += `\n Video Quantization Parameter: ${ps.VideoEncoderQP}`;

  let bytesReceived = "\n";
  let codec = "\n";

  const stats = await ps.pc.getStats(null);

  stats.forEach((stat) => {
    switch (stat.type) {
      case "data-channel": {
        cue += `\n Data Channel 🢁 ${stat.bytesSent.toLocaleString()} B 🢃 ${stat.bytesReceived.toLocaleString()} B`;
        break;
      }
      case "inbound-rtp": {
        if (stat.mediaType === "video") {
          cue += `\n 💻 ${stat.frameWidth} x ${stat.frameHeight} 📷 ${stat.framesPerSecond} FPS`;
          cue += `\n Frames Decoded: ${stat.framesDecoded.toLocaleString()}`;
          cue += `\n ${stat.packetsLost.toLocaleString()} packets lost, ${stat.framesDropped} frames dropped`;
          bytesReceived += ` video ${stat.bytesReceived.toLocaleString()} B 🢃`;
        } else if (stat.mediaType === "audio")
          bytesReceived += ` audio ${stat.bytesReceived.toLocaleString()} B 🢃`;
        break;
      }
      case "codec": {
        codec += " " + stat.mimeType;
        break;
      }
      case "transport": {
        const bitrate = ~~(
          ((stat.bytesReceived - this.bytesReceived) / (stat.timestamp - this.timestamp)) *
          (1000 * 8)
        );
        cue += `\n Bitrate 🢃 ${bitrate.toLocaleString()} bps`;
        this.bytesReceived = stat.bytesReceived;
        this.timestamp = stat.timestamp;
        break;
      }
      default: {
      }
    }
  });

  cue += bytesReceived;
  cue += codec;

  cue = new VTTCue(0, Number.MAX_SAFE_INTEGER, cue);
  cue.align = "start";

  for (const c of ps.textTracks[0].cues) {
    ps.textTracks[0].removeCue(c);
  }
  ps.textTracks[0].addCue(cue);

  ps.timeout = setTimeout(getStats, 1000);
}

// 页面加载和变化
window.onload = window.onhashchange = async () => {
  switch (location.hash) {
    case "#signal.json": {
      $("main").prepend($("form"));
      await renderConfigForm();
      break;
    }
    case "#peer-stream": {
      $("main").prepend($("video") || ps);

      if (!window.ps) {
        $("video").id = `ws://${location.host + location.pathname}/signal.html`;
        await import("./peer-stream.js");
      }

      window.addEventListener("hashchange", () => ps.remove(), { once: true });
      break;
    }
    case "#signal.js": {
      $("main").prepend($("table"));
      getProcess();
      break;
    }
    default: {
      location.hash = "#signal.json";
    }
  }
};
