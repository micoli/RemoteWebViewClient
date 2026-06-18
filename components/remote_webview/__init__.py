import re
import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation
from esphome.components import display, touchscreen, text_sensor
from esphome.const import CONF_ID, CONF_DISPLAY_ID, CONF_URL, CONF_ROTATION, CONF_TRIGGER_ID

def validate_rotation(value):
    value = cv.int_(value)
    if value not in (0, 90, 180, 270):
        raise cv.Invalid(f"Rotation must be 0, 90, 180, or 270 degrees, got {value}")
    return value


CONF_DEVICE_ID = "device_id"
CONF_TOUCHSCREEN_ID = "touchscreen_id"
CONF_SERVER = "server"
CONF_TILE_SIZE = "tile_size"
CONF_FULL_FRAME_TILE_COUNT = "full_frame_tile_count"
CONF_FULL_FRAME_AREA_THRESHOLD = "full_frame_area_threshold"
CONF_FULL_FRAME_EVERY = "full_frame_every"
CONF_EVERY_NTH_FRAME = "every_nth_frame"
CONF_MIN_FRAME_INTERVAL = "min_frame_interval"
CONF_JPEG_QUALITY = "jpeg_quality"
CONF_MAX_BYTES_PER_MSG = "max_bytes_per_msg"
CONF_BIG_ENDIAN = "big_endian"

CONF_ON_FRAME_UPDATE = "on_frame_update"
CONF_ON_DISCONNECT = "on_disconnect"
CONF_ON_CONNECT = "on_connect"
CONF_CURRENT_URL_SENSOR = "current_url_sensor"

# Used in the LVGL widget schema to reference an existing RemoteWebView component
CONF_REMOTE_WEBVIEW_ID = "remote_webview_id"

_SERVER_RE = re.compile(
    r"^(?P<host>[A-Za-z0-9](?:[A-Za-z0-9\-\.]*[A-Za-z0-9])?)\:(?P<port>\d{1,5})$"
)

AUTO_LOAD = ["text_sensor"]
DEPENDENCIES = ["display"]

def validate_host_port(value):
    s = cv.string_strict(value).strip()
    m = _SERVER_RE.match(s)
    if not m:
        raise cv.Invalid("server must be in 'host:port' format (no IPv6, no trailing colon)")

    host = m.group("host")
    port = int(m.group("port"), 10)

    if not (1 <= port <= 65535):
        raise cv.Invalid("port must be between 1 and 65535")

    return f"{host}:{port}"

ns = cg.esphome_ns.namespace("remote_webview")
RemoteWebView = ns.class_("RemoteWebView", cg.Component)

TriggerOnFrameUpdateAction = ns.class_(
    "TriggerOnFrameUpdateAction", automation.Action
)

OnFrameUpdateTrigger = ns.class_(
    "OnFrameUpdateTrigger", automation.Trigger.template()
)

OnDisconnectTrigger = ns.class_(
    "OnDisconnectTrigger", automation.Trigger.template()
)

OnConnectTrigger = ns.class_(
    "OnConnectTrigger", automation.Trigger.template()
)

# ---------------------------------------------------------------------------
# LVGL widget registration
# The LVGL widget does ONE thing: call set_obj(canvas) on an existing
# RemoteWebView component. All other configuration stays in the top-level
# remote_webview: section.
#
# Usage in YAML:
#   remote_webview:          # top-level: creates and configures the component
#     id: rwv
#     server: host:port
#     url: http://...
#     ...
#
#   lvgl:
#     pages:
#       - id: webview_page
#         widgets:
#           - remote_webview:      # LVGL widget: connects canvas to component
#               remote_webview_id: rwv
# ---------------------------------------------------------------------------
try:
    from esphome.components.lvgl.widgets import WidgetType, Widget
    from esphome.components.lvgl.types import LvType
    from esphome.components.lvgl.lvcode import lv_expr
    from esphome.components.lvgl.defines import CONF_MAIN

    # Non-compound canvas type — LVGL creates lv_canvas_create(parent) and
    # manages the lv_obj_t*. Our to_code just calls set_obj() on the component.
    _lv_canvas_t = LvType("lv_canvas_t")

    _LVGL_WIDGET_SCHEMA = cv.Schema({
        cv.Required(CONF_REMOTE_WEBVIEW_ID): cv.use_id(RemoteWebView),
    })

    class _RemoteWebViewWidgetType(WidgetType):
        def __init__(self):
            super().__init__(
                "remote_webview",
                _lv_canvas_t,
                (CONF_MAIN,),
                schema=_LVGL_WIDGET_SCHEMA,
                modify_schema={},
            )

        def get_uses(self):
            return ("canvas", "img")

        async def obj_creator(self, parent, config):
            return lv_expr.call("canvas_create", parent)

        async def to_code(self, w: Widget, config: dict):
            # w.obj is the lv_canvas_t* created by obj_creator.
            # Just wire it to the RemoteWebView component.
            var = await cg.get_variable(config[CONF_REMOTE_WEBVIEW_ID])
            cg.add(var.set_obj(w.obj))

    _RemoteWebViewWidgetType()  # auto-registers in WIDGET_TYPES
    _LVGL_WIDGET_AVAILABLE = True
except Exception:
    _LVGL_WIDGET_AVAILABLE = False

# ---------------------------------------------------------------------------
# Top-level component schema (standalone + LVGL modes)
# ---------------------------------------------------------------------------
CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(RemoteWebView),
        cv.Optional(CONF_DISPLAY_ID): cv.use_id(display.Display),
        cv.Optional(CONF_TOUCHSCREEN_ID): cv.use_id(touchscreen.Touchscreen),
        cv.Required(CONF_SERVER): validate_host_port,
        cv.Required(CONF_URL): cv.string,
        cv.Optional(CONF_DEVICE_ID): cv.string,
        cv.Optional(CONF_TILE_SIZE): cv.int_,
        cv.Optional(CONF_FULL_FRAME_TILE_COUNT): cv.int_,
        cv.Optional(CONF_FULL_FRAME_AREA_THRESHOLD): cv.float_,
        cv.Optional(CONF_FULL_FRAME_EVERY): cv.int_,
        cv.Optional(CONF_EVERY_NTH_FRAME): cv.int_,
        cv.Optional(CONF_MIN_FRAME_INTERVAL): cv.int_,
        cv.Optional(CONF_JPEG_QUALITY): cv.int_,
        cv.Optional(CONF_MAX_BYTES_PER_MSG): cv.int_,
        cv.Optional(CONF_BIG_ENDIAN): cv.boolean,
        cv.Optional(CONF_ROTATION): validate_rotation,
        cv.Optional(CONF_ON_FRAME_UPDATE): automation.validate_automation(
            {cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(OnFrameUpdateTrigger)}
        ),
        cv.Optional(CONF_ON_DISCONNECT): automation.validate_automation(
            {cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(OnDisconnectTrigger)}
        ),
        cv.Optional(CONF_ON_CONNECT): automation.validate_automation(
            {cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(OnConnectTrigger)}
        ),
        cv.Optional(CONF_CURRENT_URL_SENSOR): text_sensor.text_sensor_schema(),
    }
).extend(cv.COMPONENT_SCHEMA)

REMOTEWEBVIEW_ACTION_SCHEMA = cv.Schema(
    {
        cv.Required(CONF_ID): cv.use_id(RemoteWebView),
    }
)


@automation.register_action(
    "remote_webview.trigger_on_frame_update",
    TriggerOnFrameUpdateAction,
    REMOTEWEBVIEW_ACTION_SCHEMA,
)
async def remote_webview_trigger_on_frame_update_to_code(config, action_id, template_arg, args):
    paren = await cg.get_variable(config[CONF_ID])
    return cg.new_Pvariable(action_id, template_arg, paren)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])

    if CONF_DISPLAY_ID in config:
        disp = await cg.get_variable(config[CONF_DISPLAY_ID])
        cg.add(var.set_display(disp))

    cg.add(var.set_server(config[CONF_SERVER]))
    cg.add(var.set_url(config[CONF_URL]))

    if CONF_TOUCHSCREEN_ID in config:
        ts = await cg.get_variable(config[CONF_TOUCHSCREEN_ID])
        cg.add(var.set_touchscreen(ts))
    if CONF_DEVICE_ID in config:
        cg.add(var.set_device_id(config[CONF_DEVICE_ID]))
    if CONF_TILE_SIZE in config:
        cg.add(var.set_tile_size(config[CONF_TILE_SIZE]))
    if CONF_FULL_FRAME_TILE_COUNT in config:
        cg.add(var.set_full_frame_tile_count(config[CONF_FULL_FRAME_TILE_COUNT]))
    if CONF_FULL_FRAME_AREA_THRESHOLD in config:
        cg.add(var.set_full_frame_area_threshold(config[CONF_FULL_FRAME_AREA_THRESHOLD]))
    if CONF_FULL_FRAME_EVERY in config:
        cg.add(var.set_full_frame_every(config[CONF_FULL_FRAME_EVERY]))
    if CONF_EVERY_NTH_FRAME in config:
        cg.add(var.set_every_nth_frame(config[CONF_EVERY_NTH_FRAME]))
    if CONF_MIN_FRAME_INTERVAL in config:
        cg.add(var.set_min_frame_interval(config[CONF_MIN_FRAME_INTERVAL]))
    if CONF_JPEG_QUALITY in config:
        cg.add(var.set_jpeg_quality(config[CONF_JPEG_QUALITY]))
    if CONF_MAX_BYTES_PER_MSG in config:
        cg.add(var.set_max_bytes_per_msg(config[CONF_MAX_BYTES_PER_MSG]))
    if CONF_BIG_ENDIAN in config:
        cg.add(var.set_big_endian(config[CONF_BIG_ENDIAN]))
    if CONF_ROTATION in config:
        cg.add(var.set_rotation(config[CONF_ROTATION]))

    await cg.register_component(var, config)

    for conf in config.get(CONF_ON_FRAME_UPDATE, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [], conf)

    for conf in config.get(CONF_ON_DISCONNECT, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [], conf)

    for conf in config.get(CONF_ON_CONNECT, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [], conf)

    if CONF_CURRENT_URL_SENSOR in config:
        sens = await text_sensor.new_text_sensor(config[CONF_CURRENT_URL_SENSOR])
        cg.add(var.set_url_sensor(sens))
