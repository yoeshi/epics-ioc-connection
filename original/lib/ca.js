const ffi = require('ffi')
const ref = require('ref')
const EventEmitter = require('events').EventEmitter
const dbr = require('./codes').dbr
const mask = require('./codes').mask
const state = require('./codes').state
const nativeType = require('./codes').nativeType
const StructType = require('ref-struct')
const ArrayType = require('ref-array')
const path = require('path')

module.exports = ca = {}
ca.Channel = Channel

let LIBCA_PATH = process.env.NODE_EPICS_LIBCA
if (!LIBCA_PATH) {
  LIBCA_PATH = path.join(process.env.EPICS_BASE, 'lib', process.env.EPICS_HOST_ARCH, 'libca')
}
const MAX_STRING_SIZE = 40

const chanId = ref.types.long
const evid = ref.types.long
const chtype = ref.types.long

const libca = ffi.Library(LIBCA_PATH, {
  ca_message: ['string', ['int']],
  ca_context_create: ['int', ['int']],
  ca_current_context: ['int', []],
  ca_pend_event: ['int', ['float']],
  ca_pend_io: ['int', ['float']],
  ca_test_io: ['int', []],
  ca_create_channel: ['int', ['string', 'pointer', 'pointer', 'int', 'pointer']],
  ca_host_name: ['string', ['long']],
  ca_field_type: ['short', ['long']],
  ca_state: ['short', [chanId]],
  ca_element_count: ['int', ['long']],
  ca_name: ['string', ['long']],
  ca_array_get: ['int', ['int', 'ulong', chanId, 'pointer']],
  ca_array_get_callback: ['int', ['int', 'ulong', chanId, 'pointer', 'pointer']],
  ca_array_put_callback: ['int', [chtype, 'ulong', chanId, 'pointer',
    'pointer', 'pointer']],
  ca_create_subscription: ['int', ['int', 'ulong', chanId, 'long', 'pointer', 'pointer', 'pointer']],
  ca_clear_subscription: ['int', [evid]],
  ca_clear_channel: ['int', [chanId]]
})

ca.context = function () {
  if (!_context) {
    _context = libca.ca_context_create(1)
  }
  return _context
}

var _context = ca.context()

function message (code) {
  return libca.ca_message(code)
};

function pend () {
  libca.ca_pend_event(pendDelay)
  libca.ca_pend_io(pendDelay)
}

function stringArrayToBuffer (array) {
  const count = array.length
  const buf = new Buffer(count * MAX_STRING_SIZE)
  for (let i = 0; i < count; i += 1) {
    ref.writeCString(buf, i * MAX_STRING_SIZE, array[i])
  }
  return buf
}

function coerceBufferToNativeType (buf, dbrType, count) {
  var array = []
  if (dbrType === dbr.STRING) {
    const bufRef = ref.reinterpret(buf, count * MAX_STRING_SIZE)
    for (let i = 0; i < count; i++) {
      array.push(bufRef.readCString(i * MAX_STRING_SIZE))
    }
  } else {
    const GetArrayType = ArrayType(ref.types[nativeType[dbrType]])
    var array = new GetArrayType(buf)
    array.length = count
    array = array.toArray()
  }
  if (count === 1) {
    return array[0]
  } else {
    return array
  }
}

var pendDelay = 1.e-5
const size_tPtr = ref.refType(ref.types.size_t)
const dblPtr = ref.refType(ref.types.double)

const evargs_t = StructType({
  usr: size_tPtr,
  chid: chanId,
  type: ref.types.long,
  count: ref.types.long,
  dbr: size_tPtr,
  status: ref.types.int
})

function Channel (pvName) {
  const self = this
  EventEmitter.call(self)
  self.fieldType = null
  self.count = null

  let monitorCallbackPtr = null
  let monitorEventIdPtr = null
  const getCallbackPtrs = []
  let connectionStateChangePtr = null

  self.pvName = pvName
  self.state = function () {
    if (!self.chid) {
      return state.CS_CLOSED
    }
    return libca.ca_state(self.chid)
  }
  self.connected = function () {
    return self.state() === state.CS_CONN
  }
  self.connect = function (options, callback) {
    if (typeof options === 'undefined') {
      callback = null
      options = {}
    } else if (typeof options === 'function') {
      callback = options
      options = {}
    }

    const timeout = options.timeout || 2000

    const chidPtr = new Buffer(chanId.size)
    chidPtr.writeInt64LE(0, 0)
    chidPtr.type = chanId

    // Not implementing this yet
    const userDataPtr = null
    const priority = 0
    let initialCallbackDone = false

    connectionStateChangePtr = new ffi.Callback('int', ['pointer', 'long'], function (chid, ev) {
      self.fieldType = libca.ca_field_type(self.chid)
      self.count = libca.ca_element_count(self.chid)
      self.emit('connection', ev)
      if (!initialCallbackDone) {
        initialCallbackDone = true
        let err = null
        if (self.state() !== state.CS_CONN) {
          err = new Error('Connection not established.')
        }
        if (callback) {
          callback(err)
        }
      }
      return 0
    })
    const err = libca.ca_create_channel(self.pvName, connectionStateChangePtr, userDataPtr, priority, chidPtr)
    pend()
    self.chid = chidPtr.deref()
    if (err !== state.ECA_NORMAL) {
      initialCallbackDone = true
      if (callback) {
        callback(new Error(message(err)))
      }
    }
    setTimeout(function () {
      if (self.state() === state.CS_NEVER_CONN) {
        initialCallbackDone = true
        if (callback) {
          callback(new Error('Never connected.'))
        }
      }
    }, timeout)
    return self
  }
  self.disconnect = function (callback) {
    let err = null
    if (monitorEventIdPtr) {
      var errCode = libca.ca_clear_subscription(monitorEventIdPtr.deref())
      pend()
      if (errCode !== state.ECA_NORMAL) {
        err = new Error(message(errCode))
      }
    }
    if (self.chid) {
      var errCode = libca.ca_clear_channel(self.chid)
      if (!err && errCode !== state.ECA_NORMAL) {
        err = new Error(message(clearErr))
      }
    }
    pend()
    self.chid = null
    if (callback) {
      callback(err)
    }
  }
  self.get = function (options, callback) {
    if (typeof options === 'undefined') {
      options = {}
      callback = null
    } else if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const fieldType = 'fieldType' in options ? options.fieldType : self.fieldType
    var getCallbackPtr = new ffi.Callback('void', [evargs_t], function (args) {
      if (state.ECA_NORMAL !== args.status) {
        callback(new Error(message(args.status)))
      }
      const value = coerceBufferToNativeType(args.dbr, args.type, self.count)
      if (callback) {
        callback(null, value)
      }
      getCallbackPtrs.splice(getCallbackPtrs.indexOf(getCallbackPtr), 1)
    })
    getCallbackPtrs.push(getCallbackPtr)
    const usrArg = null
    const err = libca.ca_array_get_callback(fieldType, self.count,
      self.chid, getCallbackPtr, usrArg)
    pend()
    return self
  }
  self.monitor = function (options) {
    options = options || {}
    const fieldType = 'fieldType' in options ? options.fieldType : self.fieldType
    monitorEventIdPtr = ref.alloc(ref.types.size_t)
    monitorCallbackPtr = new ffi.Callback('void', [evargs_t], function (args) {
      const value = coerceBufferToNativeType(args.dbr, args.type, self.count)
      self.emit('value', value)
    })
    const usrArg = null
    const err = libca.ca_create_subscription(self.fieldType, self.count,
      self.chid, mask.DBE_VALUE,
      monitorCallbackPtr, usrArg,
      monitorEventIdPtr)
    pend()
    return self
  }
  self.put = function (value, callback) {
    const putCallbackPtr = new ffi.Callback('void', [evargs_t], function (args) {
      let err = null
      if (args.status !== state.ECA_NORMAL) {
        err = new Error('Error putting value.')
      }
      if (callback) {
        callback(err)
      }
    })
    const usrArg = null
    if (!Array.isArray(value)) {
      value = [value]
    }
    const count = value.length
    let buf
    if (self.fieldType === dbr.STRING) {
      buf = stringArrayToBuffer(value)
    } else {
      const PutArrayType = ArrayType(ref.types[nativeType[self.fieldType]])
      const array = new PutArrayType(value)
      buf = array.buffer
    }
    const errCode = libca.ca_array_put_callback(self.fieldType, count,
      self.chid, buf, putCallbackPtr,
      usrArg)
    pend()
    if (errCode !== state.ECA_NORMAL) {
      callback(new Error(message(errCode)))
    }
  }
}

Channel.super_ = EventEmitter
Channel.prototype = Object.create(EventEmitter.prototype, {
  constructor: {
    value: Channel,
    enumerable: false
  }
})
