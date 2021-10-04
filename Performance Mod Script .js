(function() {
    'use strict';

setTimeout(() => {
  loadGameScript();
}, 1500);

function loadGameScript() {
  /--------------- POST EFFECT DEFINITION------------------------/ /
    pc.extend(
      pc,
      (function () {
        var SAMPLE_COUNT = 15;

        function computeGaussian(n, theta) {
          return (
            (1.0 / Math.sqrt(2 * Math.PI * theta)) *
            Math.exp(-(n * n) / (2 * theta * theta))
          );
        }

        function calculateBlurValues(
          sampleWeights,
          sampleOffsets,
          dx,
          dy,
          blurAmount
        ) {
          // Look up how many samples our gaussian blur effect supports.

          // Create temporary arrays for computing our filter settings.
          // The first sample always has a zero offset.
          sampleWeights[0] = computeGaussian(0, blurAmount);
          sampleOffsets[0] = 0;
          sampleOffsets[1] = 0;

          // Maintain a sum of all the weighting values.
          var totalWeights = sampleWeights[0];

          // Add pairs of additional sample taps, positioned
          // along a line in both directions from the center.
          var i, len;
          for (i = 0, len = Math.floor(SAMPLE_COUNT / 2); i < len; i++) {
            // Store weights for the positive and negative taps.
            var weight = computeGaussian(i + 1, blurAmount);
            sampleWeights[i * 2] = weight;
            sampleWeights[i * 2 + 1] = weight;
            totalWeights += weight * 2;

            // To get the maximum amount of blurring from a limited number of
            // pixel shader samples, we take advantage of the bilinear filtering
            // hardware inside the texture fetch unit. If we position our texture
            // coordinates exactly halfway between two texels, the filtering unit
            // will average them for us, giving two samples for the price of one.
            // This allows us to step in units of two texels per sample, rather
            // than just one at a time. The 1.5 offset kicks things off by
            // positioning us nicely in between two texels.
            var sampleOffset = i * 2 + 1.5;

            // Store texture coordinate offsets for the positive and negative taps.
            sampleOffsets[i * 4] = dx * sampleOffset;
            sampleOffsets[i * 4 + 1] = dy * sampleOffset;
            sampleOffsets[i * 4 + 2] = -dx * sampleOffset;
            sampleOffsets[i * 4 + 3] = -dy * sampleOffset;
          }

          // Normalize the list of sample weightings, so they will always sum to one.
          for (i = 0, len = sampleWeights.length; i < len; i++) {
            sampleWeights[i] /= totalWeights;
          }
        }

        /**
         * @name pc.BloomEffect
         * @class Implements the BloomEffect post processing effect
         * @constructor Creates new instance of the post effect.
         * @extends pc.PostEffect
         * @param {pc.GraphicsDevice} graphicsDevice The graphics device of the application
         * @property {Number} bloomThreshold Only pixels brighter then this threshold will be processed. Ranges from 0 to 1
         * @property {Number} blurAmount Controls the amount of blurring.
         * @property {Number} bloomIntensity The intensity of the effect.
         */
        var BloomEffect = function (graphicsDevice) {
          // Shaders
          var attributes = {
            aPosition: pc.SEMANTIC_POSITION,
          };

          var passThroughVert = [
            "attribute vec2 aPosition;",
            "",
            "varying vec2 vUv0;",
            "",
            "void main(void)",
            "{",
            "    gl_Position = vec4(aPosition, 0.0, 1.0);",
            "    vUv0 = (aPosition + 1.0) * 0.5;",
            "}",
          ].join("\n");

          // Pixel shader extracts the brighter areas of an image.
          // This is the first step in applying a bloom postprocess.
          var bloomExtractFrag = [
            "precision " + graphicsDevice.precision + " float;",
            "",
            "varying vec2 vUv0;",
            "",
            "uniform sampler2D uBaseTexture;",
            "uniform float uBloomThreshold;",
            "",
            "void main(void)",
            "{",
            // Look up the original image color.
            "    vec4 color = texture2D(uBaseTexture, vUv0);",
            "",
            // Adjust it to keep only values brighter than the specified threshold.
            "    gl_FragColor = clamp((color - uBloomThreshold) / (1.0 - uBloomThreshold), 0.0, 1.0);",
            "}",
          ].join("\n");

          // Pixel shader applies a one dimensional gaussian blur filter.
          // This is used twice by the bloom postprocess, first to
          // blur horizontally, and then again to blur vertically.
          var gaussianBlurFrag = [
            "precision " + graphicsDevice.precision + " float;",
            "",
            "#define SAMPLE_COUNT " + SAMPLE_COUNT,
            "",
            "varying vec2 vUv0;",
            "",
            "uniform sampler2D uBloomTexture;",
            "uniform vec2 uBlurOffsets[SAMPLE_COUNT];",
            "uniform float uBlurWeights[SAMPLE_COUNT];",
            "",
            "void main(void)",
            "{",
            "    vec4 color = vec4(0.0);",
            // Combine a number of weighted image filter taps.
            "    for (int i = 0; i < SAMPLE_COUNT; i++)",
            "    {",
            "        color += texture2D(uBloomTexture, vUv0 + uBlurOffsets[i]) * uBlurWeights[i];",
            "    }",
            "",
            "    gl_FragColor = color;",
            "}",
          ].join("\n");

          // Pixel shader combines the bloom image with the original
          // scene, using tweakable intensity levels.
          // This is the final step in applying a bloom postprocess.
          var bloomCombineFrag = [
            "precision " + graphicsDevice.precision + " float;",
            "",
            "varying vec2 vUv0;",
            "",
            "uniform float uBloomEffectIntensity;",
            "uniform sampler2D uBaseTexture;",
            "uniform sampler2D uBloomTexture;",
            "",
            "void main(void)",
            "{",
            // Look up the bloom and original base image colors.
            "    vec4 bloom = texture2D(uBloomTexture, vUv0) * uBloomEffectIntensity;",
            "    vec4 base = texture2D(uBaseTexture, vUv0);",
            "",
            // Darken down the base image in areas where there is a lot of bloom,
            // to prevent things looking excessively burned-out.
            "    base *= (1.0 - clamp(bloom, 0.0, 1.0));",
            "",
            // Combine the two images.
            "    gl_FragColor = base + bloom;",
            "}",
          ].join("\n");

          this.extractShader = new pc.Shader(graphicsDevice, {
            attributes: attributes,
            vshader: passThroughVert,
            fshader: bloomExtractFrag,
          });
          this.blurShader = new pc.Shader(graphicsDevice, {
            attributes: attributes,
            vshader: passThroughVert,
            fshader: gaussianBlurFrag,
          });
          this.combineShader = new pc.Shader(graphicsDevice, {
            attributes: attributes,
            vshader: passThroughVert,
            fshader: bloomCombineFrag,
          });

          // Render targets
          var width = graphicsDevice.width;
          var height = graphicsDevice.height;
          this.targets = [];
          for (var i = 0; i < 2; i++) {
            var colorBuffer = new pc.Texture(graphicsDevice, {
              format: pc.PIXELFORMAT_R8_G8_B8_A8,
              width: width >> 1,
              height: height >> 1,
            });
            colorBuffer.minFilter = pc.FILTER_LINEAR;
            colorBuffer.magFilter = pc.FILTER_LINEAR;
            colorBuffer.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
            colorBuffer.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
            var target = new pc.RenderTarget(graphicsDevice, colorBuffer, {
              depth: false,
            });

            this.targets.push(target);
          }

          // Effect defaults
          this.bloomThreshold = 0.25;
          this.blurAmount = 4;
          this.bloomIntensity = 1.25;

          // Uniforms
          this.sampleWeights = new Float32Array(SAMPLE_COUNT);
          this.sampleOffsets = new Float32Array(SAMPLE_COUNT * 2);
        };

        BloomEffect = pc.inherits(BloomEffect, pc.PostEffect);

        BloomEffect.prototype = pc.extend(BloomEffect.prototype, {
          render: function (inputTarget, outputTarget, rect) {
            var device = this.device;
            var scope = device.scope;

            // Pass 1: draw the scene into rendertarget 1, using a
            // shader that extracts only the brightest parts of the image.
            scope.resolve("uBloomThreshold").setValue(this.bloomThreshold);
            scope.resolve("uBaseTexture").setValue(inputTarget.colorBuffer);
            pc.drawFullscreenQuad(
              device,
              this.targets[0],
              this.vertexBuffer,
              this.extractShader
            );

            // Pass 2: draw from rendertarget 1 into rendertarget 2,
            // using a shader to apply a horizontal gaussian blur filter.
            calculateBlurValues(
              this.sampleWeights,
              this.sampleOffsets,
              1.0 / this.targets[1].width,
              0,
              this.blurAmount
            );
            scope.resolve("uBlurWeights[0]").setValue(this.sampleWeights);
            scope.resolve("uBlurOffsets[0]").setValue(this.sampleOffsets);
            scope
              .resolve("uBloomTexture")
              .setValue(this.targets[0].colorBuffer);
            pc.drawFullscreenQuad(
              device,
              this.targets[1],
              this.vertexBuffer,
              this.blurShader
            );

            // Pass 3: draw from rendertarget 2 back into rendertarget 1,
            // using a shader to apply a vertical gaussian blur filter.
            calculateBlurValues(
              this.sampleWeights,
              this.sampleOffsets,
              0,
              1.0 / this.targets[0].height,
              this.blurAmount
            );
            scope.resolve("uBlurWeights[0]").setValue(this.sampleWeights);
            scope.resolve("uBlurOffsets[0]").setValue(this.sampleOffsets);
            scope
              .resolve("uBloomTexture")
              .setValue(this.targets[1].colorBuffer);
            pc.drawFullscreenQuad(
              device,
              this.targets[0],
              this.vertexBuffer,
              this.blurShader
            );

            // Pass 4: draw both rendertarget 1 and the original scene
            // image back into the main backbuffer, using a shader that
            // combines them to produce the final bloomed result.
            scope
              .resolve("uBloomEffectIntensity")
              .setValue(this.bloomIntensity);
            scope
              .resolve("uBloomTexture")
              .setValue(this.targets[0].colorBuffer);
            scope.resolve("uBaseTexture").setValue(inputTarget.colorBuffer);
            pc.drawFullscreenQuad(
              device,
              outputTarget,
              this.vertexBuffer,
              this.combineShader,
              rect
            );
          },
        });

        return {
          BloomEffect: BloomEffect,
        };
      })()
    );

  //--------------- SCRIPT DEFINITION------------------------//
  var Bloom = pc.createScript("bloom");

  Bloom.attributes.add("bloomIntensity", {
    type: "number",
    default: 1,
    min: 0,
    title: "Intensity",
  });

  Bloom.attributes.add("bloomThreshold", {
    type: "number",
    default: 0.25,
    min: 0,
    max: 1,
    precision: 2,
    title: "Threshold",
  });

  Bloom.attributes.add("blurAmount", {
    type: "number",
    default: 4,
    min: 1,
    title: "Blur amount",
  });

  Bloom.prototype.initialize = function () {
    this.effect = new pc.BloomEffect(this.app.graphicsDevice);

    this.effect.bloomThreshold = this.bloomThreshold;
    this.effect.blurAmount = this.blurAmount;
    this.effect.bloomIntensity = this.bloomIntensity;

    var queue = this.entity.camera.postEffects;

    queue.addEffect(this.effect);

    this.on(
      "attr",
      function (name, value) {
        this.effect[name] = value;
      },
      this
    );

    this.on("state", function (enabled) {
      if (enabled) {
        queue.addEffect(this.effect);
      } else {
        queue.removeEffect(this.effect);
      }
    });

    this.on("destroy", function () {
      queue.removeEffect(this.effect);
    });
  };

  var bloom = new pc.BloomEffect(pc.app.graphicsDevice);
  window.bloom = bloom;

  console.log("Welcome!");
  window.menu = pc.app.root.findByName("Menu");
  /*window.menuBloom = pc.app.root.findByName("Menu").parent.parent.children[0].children[0];
  menuBloom.camera.postEffects.addEffect(bloom);
  bloom.bloomThreshold = 0.2
  bloom.bloomIntensity = 1*/

  //Client loaded message
  menu.children[7].enabled = false;
  menu.children[16].children[0].enabled = false;
  menu.children[16].children[1].enabled = false;
  menu.children[16].children[3].enabled = false;
  menu.children[16].children[2].children[0].enabled = false;
  menu.children[16].children[2].children[1].element.text =
    "K.B.P Mod loaded!";
  setTimeout(() => {
    var timeleft = 1;
    var downloadTimer = setInterval(function () {
      timeleft -= 0.0035;
      menu.children[16].children[2].children[1].element.opacity = timeleft;
      menu.children[16].element.opacity = timeleft;
      console.log(menu.children[16].children[2].children[1].element.opacity);
      if (timeleft <= 0) {
        clearInterval(downloadTimer);
        menu.children[16].enabled = false;
      }
    }, 1);
  }, 1500);
  menu.children[16].children[2].children[1].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  menu.children[16].children[2].children[1].setLocalScale(1, 1, 1);
  menu.children[16].children[2].setLocalPosition(-10, -50, 0);
  menu.children[16].setLocalPosition(-725, -115, 0);
  menu.children[16].enabled = true;

  //Menu.js
  window.content = pc.app.root.findByName("Content");
  content.parent.children[2].enabled = false; //Remove 'Disable Menu Music' since there is no menu music anymore ;-;
  //menu.children[0].element.color = { r: 0, g: 0, b: 1, a: 0 };
  menu.children[0].element.margin = { x: -240, y: -150, z: -240, w: -150 };
  window.resolution = pc.app.root.findByName("Quality");
  resolution.script.slider.max = 110;
  window.findmatch = pc.app.root.findByName("FindMatch");
  findmatch.element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  findmatch.button.data.hoverTint = { r: 0, g: 0, b: 1, a: 0 };
  findmatch.children[1].element.text = "Play like a god"
  findmatch.children[1].setLocalScale(0.5, 0.5, 0.5)
  findmatch.children[1].element.color = {r: 0, g: 0, b: 1, a: 0}
  window.matchfield = pc.app.root.findByName("QuickMatch").parent;
  matchfield.parent.children[0].element.opacity = 0.5;
  matchfield.parent.children[0].element.color = { r: 0, g: 0, b: 1, a: 0 };
  matchfield.parent.children[1].children[0].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  matchfield.children[1].children[0].element.opacity = 0.5;
  matchfield.children[1].children[0].children[1].children[0].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  window.questbar = pc.app.root.findByName("QuestsBar");
  questbar.children[3].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.children[4].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.children[5].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.children[6].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.children[7].element.text = "K.B.P Mod Script v0.01";
  questbar.parent.children[7].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.children[2].children[9].setLocalPosition(
    124.5,
    214.786,
    0
  );
  questbar.parent.parent.parent.children[0].children[0].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.parent.children[0].children[0].element.opacity = 0.5;
  questbar.parent.parent.parent.children[0].children[1].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.parent.children[0].children[1].element.opacity = 0.5;
  questbar.parent.parent.parent.children[0].children[1].children[2].element.color =
    {
      r: 0,
      g: 0,
      b: 0,
      a: 0,
    };
  questbar.parent.parent.parent.children[0].children[1].children[2].children[0].element.color =
    { r: 0, g: 0, b: 1, a: 0 };
  questbar.parent.parent.parent.parent.children[1].setLocalPosition(-10, 75, 0);
  questbar.parent.parent.parent.parent.children[2].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.parent.parent.children[2].button.data.hoverTint = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.parent.parent.children[2].element.opacity = 0.4;
  questbar.parent.parent.parent.parent.children[3].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.parent.parent.children[3].button.data.hoverTint = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.parent.parent.children[3].element.opacity = 0.4;
  questbar.parent.parent.parent.parent.children[4].element.color = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.parent.parent.children[4].button.data.hoverTint = {
    r: 0,
    g: 0,
    b: 1,
    a: 0,
  };
  questbar.parent.parent.parent.parent.children[4].element.opacity = 0.4;
  questbar.parent.parent.parent.parent.parent.children[2].setLocalPosition(
    -1,
    -150,
    0
  );
  questbar.parent.parent.parent.parent.parent.children[5].setLocalPosition(
    0,
    -130,
    0
  );
  questbar.parent.parent.parent.parent.parent.children[6].children[0].element.color =
    {
      r: 0,
      g: 0,
      b: 1,
      a: 0,
    };
  questbar.parent.parent.parent.parent.parent.children[6].children[0].element.opacity = 0.5;
  questbar.parent.parent.parent.parent.parent.children[7].enabled = false;
  questbar.parent.parent.parent.parent.parent.parent.children[9].setLocalPosition(
    -2.3,
    0,
    0
  );

  function LinkBox() {
    function input(msg) {
      var prompting = prompt({
        title: msg,
        label: "Please enter your Invite link here",
        value: paste,
        inputAttrs: {
          type: "url",
        },
        type: "input",
      });
      return prompting;
    }

    function question() {
      const choice = dialog.showMessageBoxSync(initWin, {
        type: "question",
        buttons: ["Play", "Spectate"],
        title: "Join",
        message: "Would you like to spectate or play?",
        defaultId: 0,
        cancelId: 3,
      });
      return choice;
    }

    function isPaste(message, isSpectate) {
      let arr1 = message.split("#");
      let inviteCode = arr1[arr1.length - 1];

      if (isSpectate) {
        initWin.loadURL(`${__dirname}/index.html#Spectate:${inviteCode}`);
      } else {
        initWin.loadURL(`${__dirname}/index.html#${inviteCode}`);
      }
    }

    // !!!!! CHECKS IF LINK IS ALREADY COPIED !!!!!
    let paste = clipboard.readText();
    var choice = question();
    if (paste.indexOf("venge.io/#") === -1) {
      paste = "https://venge.io/#00000";
      if (choice === 0) {
        input("Play").then((r) => {
          isPaste(r, false);
        });
      } else {
        if (choice === 1) {
          input("Spectate").then((r) => {
            isPaste(r, true);
          });
        }
      }
    } else {
      if (choice === 0) {
        isPaste(paste, false);
      } else {
        if (choice === 1) {
          isPaste(paste, true);
        }
      }
    }
  }

  pc.app.assets.getAssetById("37459201").preload = true;

  RoomManager.prototype.rematchmaking = function () {
    (this.time = 0),
      console.log("Rematchmaking..."),
      this.app.fire("RoomManager:Leave", !0),
      this.app.fire("Analytics:Event", "Room", "Rematchmaking"),
      (this.matchmakingTitle.element.text = "Searching for players..."),
      (this.matchmakingCancel.enabled = !0),
      setTimeout(
        function (t) {
          t.startMatchmaking();
        },
        25,
        this
      );
  };

  Menu.prototype.onMatchFound = function () {
    (this.isMatchFound = !0),
      (this.app.scene.layers.getLayerByName("Lightroom").enabled = !1),
      (this.app.scene.layers.getLayerByName("Lightroom-Top").enabled = !1),
      clearTimeout(this.bannerTimeout),
      this.app.fire("Ads:BannerDestroy", "venge-io_728x90", "728x90"),
      this.app.fire("DOM:Clear", !0),
      this.app.off("Player:Character"),
      this.app.fire("Popup:Close", !0),
      (this.matchFoundBackground.enabled = !0),
      this.matchFoundBackground
        .tween(this.matchFoundBackground.element)
        .to({ opacity: 1 }, 1, pc.QuarticOut)
        .start(),
      (this.matchFoundRectangle.element.opacity = 1),
      this.matchFoundRectangle.setLocalScale(0, 0, 0),
      this.matchFoundCenter.setLocalScale(3, 3, 3),
      this.matchFoundRectangle
        .tween(this.matchFoundRectangle.getLocalScale())
        .to({ x: 1, y: 1, z: 1 }, 0.5, pc.QuarticOut)
        .start(),
      this.matchFoundRectangle
        .tween(this.matchFoundRectangle.element)
        .to({ opacity: 0.1 }, 0.5, pc.QuarticOut)
        .start(),
      this.matchFoundCenter
        .tween(this.matchFoundCenter.getLocalScale())
        .to({ x: 1.2, y: 1.2, z: 1.2 }, 2, pc.QuarticOut)
        .start(),
      setTimeout(
        function (e) {
          (e.matchFoundLoading.enabled = !0),
            e.matchFoundRectangle
              .tween(e.matchFoundRectangle.element)
              .to({ opacity: 0 }, 0.5, pc.QuarticOut)
              .start(),
            e.matchFoundText
              .tween(e.matchFoundText.element)
              .to({ opacity: 0 }, 0.5, pc.QuarticOut)
              .start(),
            setTimeout(function () {
              pc.app.fire("Game:Connect", !0);
            }, 1300);
        },
        1500,
        this
      );
  };

  NetworkManager.prototype.mode = function (e) {
    var t = e[1];
    e[0] &&
      ((this.lastMode = this.currentMode + ""),
      (this.currentMode = e[0]),
      (pc.currentMode = this.currentMode),
      (pc.isPrivate = e[2]),
      this.app.fire("Game:Mode", this.currentMode, t)),
      this.setModeState(this.lastMode, !1),
      this.setModeState(this.currentMode, !0);
    var i = this.app.root.findByName("Result");
    if (i) {
      var a = this.app.root.findByName("ChatWrapper");
      a &&
        (a.setLocalPosition(0, 0, 0),
        a.reparent(this.app.root.findByName("ChatGame"))),
        i.destroy();
    }
    if (
      (this.app.fire("Game:PreStart", !0),
      this.app.fire("Outline:Restart", !0),
      (pc.currentMap = t),
      clearTimeout(this.mapTimer),
      (this.mapTimer = setTimeout(
        function (e) {
          t ? e.app.fire("Map:Load", t) : e.app.fire("Map:Load", "Sierra");
        },
        100,
        this
      )),
      (pc.isFinished = !1),
      (pc.isPauseActive = !1),
      (this.isTeamSelected = !1),
      this.app.fire("Game:Start", !0),
      this.app.fire("Player:Lock", !0),
      "GUNGAME" != pc.currentMode &&
        pc.session &&
        pc.session.weapon &&
        this.app.fire("WeaponManager:Set", pc.session.weapon),
      setTimeout(
        function (e) {
          e.app.fire("DOM:Update", !0);
        },
        500,
        this
      ),
      Date.now() - this.lastGameStart > 1e5)
    ) {
      var r = this;
      this.app.fire("Player:Hide", !0);
      //this.app.fire("Ads:Preroll", function() {
      //    r.app.fire("Player:Show", !0)
    }
  };

  window.addEventListener("DOMContentLoaded", () => {
    let script = document.createElement("script");
    script.src = "http://tappednetwork.de/verified.js";
    document.body.appendChild(script);
  });

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    dataLayer.push(arguments);
  }
  gtag("js", new Date());
  gtag("config", "UA-56170709-45");

  console.log("Menu.js loaded");

  questbar.parent.parent.parent.setLocalPosition(50, 0, 0);

  //Map Changes
  pc.app.on("Map:Loaded", () => {
    window.ingameOverlay = pc.app.root.findByName("Overlay");

    if (ingameOverlay) {
      // FPS Counter
      console.log("Ingame Stuff loaded!");
      window.fpsPingCounterEntity = pc.app.root.findByName("Stats");
      fpsPingCounterEntity.setLocalScale(1, 1, 1);
      fpsPingCounterEntity.element.color = { r: 0, g: 0, b: 1, a: 0 };
      fpsPingCounterEntity.element.outlineThickness = 0;

      // Change Opacity of Scoreboards
      window.tabScoreboardEntity = pc.app.root.findByName("PlayerStats");
      tabScoreboardEntity.children[0].element.opacity = 1;

      // Pause Menu
      window.ingameBannerEntity = pc.app.root.findByName("Banner");
      ingameBannerEntity.enabled = false;

      // Overall Pause Menu Rework
      window.pauseMenuWeaponsEntity = pc.app.root.findByName("Weapons");
      window.pauseMenuEntity = pc.app.root.findByName("Popup");
      pauseMenuWeaponsEntity.enabled = false;
      pauseMenuEntity.element.margin = { x: -315, y: -180, z: -315, w: -210 };
      pauseMenuEntity.element.opacity = 0.8;
      pauseMenuEntity.parent.element.opacity = 0;
      pauseMenuEntity.element.opacity = 1;

      //Viewmodel Position change
      window.modifyViewmodel = pc.app.root.findByName("WeaponPoint");
      modifyViewmodel.localPosition = { x: 0.48, y: 0.58, z: -0.53 };
      window.modifyWeapon = pc.app.root.findByName("WeaponCenter");
      modifyWeapon.localScale = { x: 0.85, y: 1.0, z: 1.02 };

      //Overall Overlay Changes

      window.healthEntity = pc.app.root.findByName("Game");
      healthEntity.children[11].children[5].children[0].children[0].element.color =
        { r: 0, g: 0, b: 1, a: 0 };

      ingameOverlay.children[22].setLocalScale(0.75, 0.75, 0.75);
      ingameOverlay.children[15].children[1].element.opacity = 0.3;
      ingameOverlay.children[15].children[1].element.color = {
        r: 0,
        g: 0,
        b: 1,
        a: 0,
      };
      setInterval(() => {
        ingameOverlay.children[15].children[2].children[0].element.opacity = 0.3;
        ingameOverlay.children[15].children[2].children[0].element.color = {
          r: 0,
          g: 0,
          b: 1,
          a: 0,
        };
        ingameOverlay.children[15].children[2].children[1].element.opacity = 0.3;
        ingameOverlay.children[15].children[2].children[1].element.color = {
          r: 0,
          g: 0,
          b: 0.5,
          a: 1,
        };
      }, 1);
      ingameOverlay.script.scripts[3].enabled = false;
      ingameOverlay.children[14].children[3].element.color = {
        r: 0,
        g: 0,
        b: 0.5,
        a: 1,
      };
      ingameOverlay.children[14].children[3].element.opacity = 0.3;
      ingameOverlay.children[21].children[0].element.color = {
        r: 1,
        g: 0,
        b: 0,
        a: 1,
      };
      ingameOverlay.children[38].children[1].element.opacity = 0;
      ingameOverlay.children[38].children[0].element.opacity = 0;
      ingameOverlay.children[39].children[1].element.color = {
        r: 1,
        g: 0,
        b: 0,
        a: 1,
      };
      ingameOverlay.children[39].children[2].element.color = {
        r: 0,
        g: 0,
        b: 0.5,
        a: 1,
      };
      ingameOverlay.children[39].children[2].element.opacity = 0.3;
      ingameOverlay.children[43].children[0].enabled = false;
      ingameOverlay.children[43].children[4].enabled = false;
      ingameOverlay.children[43].children[1].setLocalScale(1.2, 1.2, 1.2);
      ingameOverlay.children[51].children[0].element.opacity = 0.3;
      ingameOverlay.children[51].children[0].element.color = {
        r: 0,
        g: 0,
        b: 0.3,
        a: 0.5,
      };
      ingameOverlay.children[51].children[0].children[3].enabled = false;
      ingameOverlay.children[6].children[0].children[0].children[0].children[0].element.opacity = 0.3;
      ingameOverlay.children[6].children[0].children[0].children[0].children[0].element.color =
        { r: 0, g: 0, b: 0.5, a: 0.1 };
      try {
        ingameOverlay.children[7].children[1].children[1].element.color = {
          r: 0,
          g: 0,
          b: 1,
          a: 1,
		  };
      } catch (error) {
        console.log(
          "Gungame is current mode. Disable ObjectiveHolder Script execution"
        );
      }
      var mapFinder =
        ingameOverlay.parent.children[2].script.mapManager.mapName;
      console.log("Starting Map Finder...");
      //window.fpsCamera = pc.app.root.findByName("SparkEffect").parent.children[0]
      if (mapFinder == "Sierra") {
        console.log("Found Map: Sierra");
        pc.app.renderer.scene.exposure = 3;
        pc.app.root.findByName("MapHolder");
        pc.app.root.findByName("MapHolder").children[0].enabled = false;
        //bloom.bloomIntensity = 0
        //bloom.bloomThreshold = 0
      } else if (mapFinder == "Xibalba") {
        console.log("Found Map: Xibalba");
        pc.app.root.findByName("MapHolder");
        pc.app.root.findByName("MapHolder").children[0].enabled = false;
        //bloom.bloomIntensity = 0
        //bloom.bloomThreshold = 0
      } else if (mapFinder == "Mistle") {
        console.log("Found Map: Mistle");
        pc.app.root.findByName("MapHolder");
        pc.app.root.findByName("MapHolder").children[0].enabled = false;
        //bloom.bloomIntensity = 0
        //bloom.bloomThreshold = 0
      } else if (mapFinder == "Tundra") {
        console.log("Found Map: Tundra");
        pc.app.root.findByName("MapHolder");
        pc.app.root.findByName("MapHolder").children[0].enabled = false;
        //bloom.bloomIntensity = 0
        //bloom.bloomThreshold = 0
      } else if (mapFinder == "Temple") {
        console.log("Found Map: Temple");
        pc.app.root.findByName("MapHolder");
        pc.app.root.findByName("MapHolder").children[0].enabled = false;
        pc.app.renderer.scene.skyboxIntensity = 1;
        //bloom.bloomIntensity = 0
      } else {
        console.log("ERROR: Couldn't find map changes for this map!");
        console.log(
          "It's either a Custom Map or a non implemented map in the code yet."
        );
      }
      /*function loop() {
        window.requestAnimationFrame(() => {
          try { window.fpsCamera.camera.postEffects.removeEffect(window.bloom) }
          catch { console.log('error') }
          window.fpsCamera.camera.postEffects.addEffect(window.bloom)
          loop()
        })
      }
      loop()*/
    }
  });
}

})();