import toPromise from './toPromise.js';

function logApiCall(self, name, args) {
  /* istanbul ignore if */
  if (self.constructor.listeners('debug').length) {
    const logArgs = ['api', self.name, name, ...args.slice(0, -1)];
    self.constructor.emit('debug', logArgs);

    // override the callback itself to log the response
    const origCallback = args[args.length - 1];
    args[args.length - 1] = (err, res) => {
      const responseArgs = ['api', self.name, name, ...(err ? ['error', err] : ['success', res])];
      self.constructor.emit('debug', responseArgs);
      origCallback(err, res);
    };
  }
}

function adapterFun(name, callback) {
  return toPromise(function (...args) {
    if (this._closed) {
      return Promise.reject(new Error('database is closed'));
    }
    if (this._destroyed) {
      return Promise.reject(new Error('database is destroyed'));
    }
    
    logApiCall(this, name, args);
    
    if (!this.taskqueue.isReady) {
      return new Promise((resolve, reject) => {
        this.taskqueue.addTask((failed) => {
          failed ? reject(failed) : resolve(this[name].apply(this, args));
        });
      });
    }
    return callback.apply(this, args);
  });
}

export default adapterFun;