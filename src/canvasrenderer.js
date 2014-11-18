'use strict';

var async = require('async');
var blend = require('./blend');
var process = require('./process');

// Dictionary of blend modes that the client browser does or does not support.
var nativeBlendModes = blend.getNativeModes();

// Utility function that passes its input (normally a html canvas) to the next function.
function passThrough(canvas, callback) {
    callback(null, canvas);
}

function createImageData(ctx, width, height) {
    if (ctx.createImageData) {
        return ctx.createImageData(width, height);
    } else {
        return ctx.getImageData(0, 0, width, height);
    }
}

// RENDERING.

// The Layer and ImageCanvas objects don't do any actual pixel operations themselves,
// they only contain information about the operations. The actual rendering is done
// by a Renderer object. Currently there is only one kind available, the CanvasRenderer,
// which uses the HTML Canvas object (containing the pixel data) and a 2D context that
// acts on this canvas object. In the future, a webgl renderer might be added as well.

var CanvasRenderer = {};

// Renders a html canvas as an html Image. Currently unused.
CanvasRenderer.toImage = function () {
    return function (canvas, callback) {
        var img = new Image();
        img.width = canvas.width;
        img.height = canvas.height;
        img.src = canvas.toDataURL();
        callback(null, img);
    };
};


// 'LOADING' OF LAYERS.

// Returns a html canvas dependent on the type of the layer provided.
CanvasRenderer.load = function (iCanvas, layer) {
    if (layer.isPath()) {
        return CanvasRenderer.loadFile(layer.data);
    } else if (layer.isFill()) {
        return CanvasRenderer.generateColor(iCanvas, layer);
    } else if (layer.isGradient()) {
        return CanvasRenderer.generateGradient(iCanvas, layer);
    } else if (layer.isHtmlCanvas()) {
        return CanvasRenderer.loadHtmlCanvas(layer.data);
    } else if (layer.isImage()) {
        return CanvasRenderer.loadImage(layer.data);
    } else if (layer.isImageCanvas()) {
        return CanvasRenderer.loadImageCanvas(layer.data);
    }
};

// Returns a html canvas from an image file location.
CanvasRenderer.loadFile = function (src) {
    return function (_, callback) {
        var source = new Image(),
            canvas = document.createElement('canvas'),
            ctx = canvas.getContext('2d');

        source.onload = function () {
            canvas.width = source.width;
            canvas.height = source.height;
            ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
            callback(null, canvas);
        };
        source.src = src;
    };
};

// Passes a html canvas.
CanvasRenderer.loadHtmlCanvas = function (canvas) {
    return function (_, callback) {
        callback(null, canvas);
    };
};

// Returns a html canvas from rendering an ImageCanvas.
CanvasRenderer.loadImageCanvas = function (iCanvas) {
    return function (_, callback) {
        iCanvas.render(function (canvas) {
            callback(null, canvas);
        });
    };
};

// Returns a html canvas from rendering a stored Image file.
CanvasRenderer.loadImage = function (img) {
    return function (_, callback) {
        var canvas = document.createElement('canvas'),
            ctx = canvas.getContext('2d');

        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        callback(null, canvas);
    };
};

// Returns a html canvas with a solid fill color.
CanvasRenderer.generateColor = function (iCanvas, layer) {
    return function (_, callback) {
        var width = layer.width !== undefined ? layer.width : iCanvas.width,
            height = layer.height !== undefined ? layer.height : iCanvas.height,
            canvas = document.createElement('canvas'),
            ctx = canvas.getContext('2d');

        canvas.width = width;
        canvas.height = height;
        ctx.fillStyle = layer.data;
        ctx.fillRect(0, 0, width, height);
        callback(null, canvas);
    };
};

// Returns a html canvas with a gradient.
CanvasRenderer.generateGradient = function (iCanvas, layer) {
    return function (_, callback) {
        var grd, x1, y1, x2, y2,
            width = layer.width !== undefined ? layer.width : iCanvas.width,
            height = layer.height !== undefined ? layer.height : iCanvas.height,
            cx = width / 2,
            cy = height / 2,
            canvas = document.createElement('canvas'),
            ctx = canvas.getContext('2d'),
            data = layer.data,
            type = data.type || 'linear',
            rotateDegrees = data.rotation || 0;

        if (type === 'radial') {
            grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(width, height) / 2);
        } else {
            // Rotation code taken from html5-canvas-gradient-creator:
            // Website: http://victorblog.com/html5-canvas-gradient-creator/
            // Code: https://github.com/evictor/html5-canvas-gradient-creator/blob/master/js/src/directive/previewCanvas.coffee
            if (rotateDegrees < 0) {
                rotateDegrees += 360;
            }
            if ((0 <= rotateDegrees && rotateDegrees < 45)) {
                x1 = 0;
                y1 = height / 2 * (45 - rotateDegrees) / 45;
                x2 = width;
                y2 = height - y1;
            } else if ((45 <= rotateDegrees && rotateDegrees < 135)) {
                x1 = width * (rotateDegrees - 45) / (135 - 45);
                y1 = 0;
                x2 = width - x1;
                y2 = height;
            } else if ((135 <= rotateDegrees && rotateDegrees < 225)) {
                x1 = width;
                y1 = height * (rotateDegrees - 135) / (225 - 135);
                x2 = 0;
                y2 = height - y1;
            } else if ((225 <= rotateDegrees && rotateDegrees < 315)) {
                x1 = width * (1 - (rotateDegrees - 225) / (315 - 225));
                y1 = height;
                x2 = width - x1;
                y2 = 0;
            } else if (315 <= rotateDegrees) {
                x1 = 0;
                y1 = height - height / 2 * (rotateDegrees - 315) / (360 - 315);
                x2 = width;
                y2 = height - y1;
            }
            grd = ctx.createLinearGradient(x1, y1, x2, y2);
        }
        grd.addColorStop(data.spread || 0, data.startColor);
        grd.addColorStop(1, data.endColor);

        canvas.width = width;
        canvas.height = height;
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, width, height);
        callback(null, canvas);
    };
};


// PROCESSING OF LAYERS.

// Performs a number of filtering operations on an html image.
// This method executes on the main thread if web workers aren't available on the current system.
CanvasRenderer.processImage = function (filters) {
    if (filters.length === 0) {
        return passThrough;
    }

    return function (canvas, callback) {
        var i, filter, tmpData,
            ctx = canvas.getContext('2d'),
            width = canvas.width,
            height = canvas.height,
            inData = ctx.getImageData(0, 0, width, height),
            outData = createImageData(ctx, width, height);

        for (i = 0; i < filters.length; i += 1) {
            if (i > 0) {
                tmpData = inData;
                inData = outData;
                outData = tmpData;
            }
            filter = filters[i];
            process[filter.name](inData.data, outData.data, width, height, filter.options);
        }

        ctx.putImageData(outData, 0, 0);
        callback(null, canvas);
    };
};

// Renders the layer mask and applies it to the layer that it is supposed to mask.
CanvasRenderer.processMask = function (mask) {
    if (mask.layers.length === 0) {
        return passThrough;
    }
    return function (canvas, callback) {
        mask.width = canvas.width;
        mask.height = canvas.height;

        // First, make a black and white version of the masking canvas and pass
        // the result to the masking operation.
        CanvasRenderer.renderBW(mask, function (c) {
            var data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data,
                maskFilter = {name: 'mask', options: {data: data, x: 0, y: 0, width: c.width, height: c.height} },
                fn = CanvasRenderer.processImage([maskFilter]);
            fn(canvas, callback);
        });
    };
};

// Processes a single layer. First the layer image is loaded, then a mask (if applicable) is applied to it,
// and finally the filters (if any) are applied to it.
function processLayers(iCanvas) {
    return function (layer, callback) {
        async.compose(
            CanvasRenderer.processImage(layer.filters),
            CanvasRenderer.processMask(layer.mask),
            CanvasRenderer.load(iCanvas, layer)
        )(null, callback);
    };
}


// LAYER TRANFORMATIONS.

// Transforms the 2d context that acts upon this layer's image. Utility function. -> Rename this?
function transformLayer(ctx, iCanvas, layer) {
    var translate = layer.tx !== 0 || layer.ty !== 0,
        scale = layer.sx !== 1 || layer.sy !== 1,
        rotate = layer.rot !== 0,
        flip = layer.flip_h || layer.flip_v;

    if (translate) {
        ctx.translate(layer.tx, layer.ty);
    }
    if (scale || rotate || flip) {
        ctx.translate(iCanvas.width / 2, iCanvas.height / 2);
        if (rotate) {
            ctx.rotate(util.radians(layer.rot));
        }
        if (scale) {
            ctx.scale(layer.sx, layer.sy);
        }
        if (flip) {
            ctx.scale(layer.flip_h ? -1 : 1, layer.flip_v ? -1 : 1);
        }
        ctx.translate(-iCanvas.width / 2, -iCanvas.height / 2);
    }
}

// Transforms the bounds of a layer (the bounding rectangle) and returns the bounding rectangle
// that encloses this transformed rectangle.
function transformRect(iCanvas, layer) {
    var i, pt, minx, miny, maxx, maxy, t,
        width = layer.img.width,
        height = layer.img.height,
        p1 = {x: 0, y: 0},
        p2 = {x: width, y: 0},
        p3 = {x: 0, y: height},
        p4 = {x: width, y: height},
        points = [p1, p2, p3, p4];

    t = util.transform();
    t.translate((iCanvas.width - width) / 2, (iCanvas.height - height) / 2);
    t.translate(layer.tx, layer.ty);
    t.translate(width / 2, height / 2);
    t.rotate(layer.rot);
    t.scale(layer.sx, layer.sy);
    t.translate(-width / 2, -height / 2);

    for (i = 0; i < 4; i += 1) {
        pt = t.transformPoint(points[i]);
        if (i === 0) {
            minx = maxx = pt.x;
            miny = maxy = pt.y;
        } else {
            if (pt.x < minx) {
                minx = pt.x;
            }
            if (pt.x > maxx) {
                maxx = pt.x;
            }
            if (pt.y < miny) {
                miny = pt.y;
            }
            if (pt.y > maxy) {
                maxy = pt.y;
            }
        }
    }
    return {x: minx, y: miny, width: maxx - minx, height: maxy - miny};
}

// Calculates the intersecting rectangle of two input rectangles.
function rectIntersect(r1, r2) {
    var right1 = r1.x + r1.width,
        bottom1 = r1.y + r1.height,
        right2 = r2.x + r2.width,
        bottom2 = r2.y + r2.height,

        x = Math.max(r1.x, r2.x),
        y = Math.max(r1.y, r2.y),
        w = Math.max(Math.min(right1, right2) - x, 0),
        h = Math.max(Math.min(bottom1, bottom2) - y, 0);
    return {x: x, y: y, width: w, height: h};
}

// Calculates the mimimal area that a transformed layer needs so that it
// can still be drawn on the canvas. Returns a rectangle.
function calcLayerRect(iCanvas, layer) {
    var rect = transformRect(iCanvas, layer);
    rect = rectIntersect(rect, {x: 0, y: 0, width: iCanvas.width, height: iCanvas.height});
    return { x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height)};
}

// Transforms a layer and returns the resulting pixel data.
function getTransformedLayerData(iCanvas, layer, rect) {
    var canvas = document.createElement('canvas'),
        ctx = canvas.getContext('2d');
    canvas.width = rect.width;
    canvas.height = rect.height;
    ctx.translate(-rect.x, -rect.y);
    transformLayer(ctx, iCanvas, layer);
    ctx.drawImage(layer.img, layer.x, layer.y);
    return ctx.getImageData(0, 0, rect.width, rect.height);
}


// LAYER BLENDING.

// Blends the subsequent layer images with the base layer and returns a single image.
// This method is used when web workers aren't available for use on this system.
CanvasRenderer.mergeManualBlend = function (iCanvas, layerData) {
    return function (canvas, callback) {
        var i, layer, blendData, tmpData, layerOptions, rect,
            ctx = canvas.getContext('2d'),
            width = iCanvas.width,
            height = iCanvas.height,
            baseData = ctx.getImageData(0, 0, width, height),
            outData = createImageData(ctx, width, height);
        for (i = 0; i < layerData.length; i += 1) {
            layer = layerData[i];
            rect = calcLayerRect(iCanvas, layer);
            if (rect.width > 0 && rect.height > 0) {
                if (i > 0) {
                    tmpData = baseData;
                    baseData = outData;
                    outData = tmpData;
                }
                blendData = getTransformedLayerData(iCanvas, layer, rect);
                layerOptions = {data: blendData.data, width: rect.width, height: rect.height, opacity: layer.opacity, dx: rect.x, dy: rect.y};
                if (blend[layer.blendmode] === undefined) {
                    throw new Error('No blend mode named \'' + layer.blendmode + '\'');
                }
                blend[layer.blendmode](baseData.data, outData.data, width, height, layerOptions);
            }
        }
        ctx.putImageData(outData, 0, 0);
        callback(null, canvas);
    };
};

// Renders a single layer. This is useful when there's only one layer available (and no blending is needed)
// or to render the base layer on which subsequent layers are blended.
CanvasRenderer.singleLayerWithOpacity = function (iCanvas, layer) {
    var canvas = document.createElement('canvas'),
        ctx = canvas.getContext('2d');

    canvas.width = iCanvas.width;
    canvas.height = iCanvas.height;

    ctx.save();
    transformLayer(ctx, iCanvas, layer);
    if (layer.opacity !== 1) {
        ctx.globalAlpha = layer.opacity;
    }
    ctx.drawImage(layer.img, layer.x, layer.y);
    ctx.restore();
    return canvas;
};

// Blends the subsequent layer images with the base layer and returns the resulting image.
// This method is used when the system supports the requested blending mode(s).
CanvasRenderer.mergeNativeBlend = function (iCanvas, layerData) {
    return function (canvas, callback) {
        var i, layer,
            ctx = canvas.getContext('2d');
        for (i = 0; i < layerData.length; i += 1) {
            layer = layerData[i];
            ctx.save();
            transformLayer(ctx, iCanvas, layer);
            if (layer.opacity !== 1) {
                ctx.globalAlpha = layer.opacity;
            }
            if (layer.blendmode !== 'source-over') {
                ctx.globalCompositeOperation = layer.blendmode;
            }
            ctx.drawImage(layer.img, layer.x, layer.y);
            ctx.restore();
        }
        callback(null, canvas);
    };
};

// Merges the different canvas layers together in a single image and returns this as a html canvas.
CanvasRenderer.merge = function (iCanvas, layerData, callback) {
    var i, mode, useNative, currentList,
        layer = layerData[0],
        canvas = CanvasRenderer.singleLayerWithOpacity(iCanvas, layer),
        renderPipe = [function (_, cb) {
            cb(null, canvas);
        }];

    function pushList() {
        if (useNative !== undefined) {
            var fn = useNative ? CanvasRenderer.mergeNativeBlend : CanvasRenderer.mergeManualBlend;
            renderPipe.unshift(fn(iCanvas, currentList));
        }
    }

    for (i = 1; i < layerData.length; i += 1) {
        layer = layerData[i];
        mode = layer.blendmode;
        // todo: handle blendmode aliases.
        if (useNative === undefined || useNative !== nativeBlendModes[mode]) {
            pushList();
            currentList = [];
        }
        currentList.push(layer);
        useNative = nativeBlendModes[mode];
        if (i === layerData.length - 1) {
            pushList();
        }
    }

    async.compose.apply(null, renderPipe)(null, function () {
        callback(canvas);
    });
};

CanvasRenderer.composite = function (iCanvas, layerData, callback) {
    if (!layerData || layerData.length === 0) {
        callback(null);
        return;
    }
    if (layerData.length === 1) {
        callback(CanvasRenderer.singleLayerWithOpacity(iCanvas, layerData[0]));
        return;
    }

    CanvasRenderer.merge(iCanvas, layerData, callback);
};

// Returns an object with additional layer information as well as the input images
// to be passed to the different processing functions.
function getLayerData(iCanvas, layerImages) {
    var i, d, x, y, layer, layerImg, layerData = [];
    for (i = 0; i < layerImages.length; i += 1) {
        layer = iCanvas.layers[i];
        layerImg = layerImages[i];
        x = (iCanvas.width - layerImg.width) / 2;
        y = (iCanvas.height - layerImg.height) / 2;
        d = { img: layerImg, x: x, y: y,
            opacity: layer.opacity,
            blendmode: layer.blendmode,
            tx: layer.tx, ty: layer.ty,
            sx: layer.sx, sy: layer.sy,
            rot: layer.rot,
            flip_h: layer.flip_h, flip_v: layer.flip_v
        };
        layerData.push(d);
    }
    return layerData;
}

// Renders the image canvas. Top level.
CanvasRenderer.render = function (iCanvas, callback) {
    async.map(iCanvas.layers,
        processLayers(iCanvas), function (err, layerImages) {
            if (callback) {
                CanvasRenderer.composite(iCanvas, getLayerData(iCanvas, layerImages), callback);
            }
        });
};

// Renders the image canvas and turns it into a black and white image. Useful for rendering a layer mask.
CanvasRenderer.renderBW = function (iCanvas, callback) {
    CanvasRenderer.render(iCanvas, function (canvas) {
        var data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
            bwFilter = {name: 'luminancebw'},
            fn = CanvasRenderer.processImage([bwFilter]);
        fn(canvas, function (err, c) {
            callback(c);
        });
    });
};

module.exports = CanvasRenderer;